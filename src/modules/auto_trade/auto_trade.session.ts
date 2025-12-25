import { Logger } from '@nestjs/common';
import { BinanceTickerService } from '../binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from '../hyperliquid/websocket/hyperliquid.ticker.service';
import { ParadexTickerService } from '../paradex/websocket/paradex.ticker.service';
import { ExtendedTickerService } from '../extended/websocket/extended.ticker.service';
import { LighterTickerService } from '../lighter/websocket/lighter.ticker.service';
import { LighterService } from '../lighter/lighter.service';
import { CriticalLogger } from '../../common/critical.logger'; // H7 FIX
import * as Helpers from './auto_trade.helpers';
import { ITradingServices } from './auto_trade.helpers'; // Импортируем интерфейс
import { TradeSessionConfig, ExchangeName, TradeStatusData } from './auto_trade.types';

// Тип для тикеров
type TickerInstance =
    | BinanceTickerService
    | HyperliquidTickerService
    | ParadexTickerService
    | ExtendedTickerService
    | LighterTickerService;

export class AutoTradeSession {
    private readonly logger = new Logger(AutoTradeSession.name);

    private activeLongTicker: TickerInstance | null = null;
    private activeShortTicker: TickerInstance | null = null;

    private currentLongAsk: number | null = null;
    private currentShortBid: number | null = null;

    private stepTimeout: NodeJS.Timeout | null = null;
    private isStopping = false;

    // Состояние прогресса
    private filledQuantity = 0;
    private iteration = 1;
    private consecutiveErrors = 0;
    private waitingForPricesCount = 0; // C6 FIX

    // Health Buffer (восстановлено)
    private readonly ALLOWED_BP_SLIPPAGE = 2; // Допуск проскальзывания BP
    private bpHealthBuffer: boolean[] = [true, true, true];

    // H4 FIX: Session Timeout
    private sessionStartTime = Date.now();
    private readonly MAX_SESSION_DURATION = 3600_000; // 1 час

    constructor(
        private readonly config: TradeSessionConfig,
        // Передаем REST-сервисы (они синглтоны, это ок, если ключи общие)
        private readonly services: ITradingServices,
        private readonly lighterDataService: LighterService // Для поиска ID
    ) { }

    // Фабрика тикеров (ИЗОЛЯЦИЯ)
    private createTicker(exchange: ExchangeName): TickerInstance {
        switch (exchange) {
            case 'Binance': return new BinanceTickerService();
            case 'Hyperliquid': return new HyperliquidTickerService();
            case 'Paradex': return new ParadexTickerService();
            case 'Extended': return new ExtendedTickerService();
            case 'Lighter': return new LighterTickerService();
            default: throw new Error(`Unknown exchange ${exchange}`);
        }
    }

    public async start() {
        this.isStopping = false;
        const { coin, longExchange, shortExchange, totalQuantity, onUpdate } = this.config;

        await onUpdate(
            `🚀 <b>СТАРТ СЕССИИ</b>\n` +
            `Монета: <b>${coin}</b>\n` +
            `Long: ${longExchange} | Short: ${shortExchange}\n` +
            `Vol: ${totalQuantity}`
        );

        try {
            // 1. Получаем символы
            let longSymbol = Helpers.getUnifiedSymbol(longExchange, coin, longExchange === 'Lighter');
            let shortSymbol = Helpers.getUnifiedSymbol(shortExchange, coin, shortExchange === 'Lighter');

            // 2. Lighter ID Lookup
            if (longExchange === 'Lighter') {
                const id = await this.lighterDataService.getMarketId(longSymbol, this.config.userId);
                if (id === null) throw new Error(`Market ID not found for ${longSymbol} on Lighter`);
                longSymbol = id.toString();
            }
            if (shortExchange === 'Lighter') {
                const id = await this.lighterDataService.getMarketId(shortSymbol, this.config.userId);
                if (id === null) throw new Error(`Market ID not found for ${shortSymbol} on Lighter`);
                shortSymbol = id.toString();
            }

            // 3. Создаем тикеры
            this.activeLongTicker = this.createTicker(longExchange);
            this.activeShortTicker = this.createTicker(shortExchange);

            // 4. Подключаем сокеты
            await Promise.all([
                this.activeLongTicker.start(longSymbol, (_, ask: string) => {
                    this.currentLongAsk = parseFloat(ask);
                }),
                this.activeShortTicker.start(shortSymbol, (bid: string, _) => {
                    this.currentShortBid = parseFloat(bid);
                })
            ]);

            // 5. Запускаем цикл
            this.runStep();

        } catch (error: any) {
            await onUpdate(`❌ Start Error: ${error.message}`);
            this.stop('Start error');
            this.config.onFinished();
        }
    }

    private async runStep() {
        if (this.isStopping) return;

        // H4 FIX: Проверка времени жизни сессии
        if (Date.now() - this.sessionStartTime > this.MAX_SESSION_DURATION) {
            await this.config.onUpdate('⏰ Таймаут сессии (1 час). Остановка.');
            this.stop('Session timeout');
            this.config.onFinished();
            return;
        }

        const { targetBp, stepQuantity, totalQuantity, onUpdate, onStatusUpdate } = this.config;

        // A. Ожидание цен (C6 FIX - защита от бесконечного цикла)
        if (!this.currentLongAsk || !this.currentShortBid) {
            this.waitingForPricesCount++;

            // Если ждем больше 60 секунд - переподключаем WebSocket
            if (this.waitingForPricesCount > 60) {
                await onUpdate(`❌ Нет цен 60 секунд. Перезапуск WebSocket...`);

                try {
                    // Останавливаем старые WebSocket
                    if (this.activeLongTicker) this.activeLongTicker.stop();
                    if (this.activeShortTicker) this.activeShortTicker.stop();

                    // Создаем новые
                    this.activeLongTicker = this.createTicker(this.config.longExchange);
                    this.activeShortTicker = this.createTicker(this.config.shortExchange);

                    // Получаем символы
                    let longSymbol = Helpers.getUnifiedSymbol(this.config.longExchange, this.config.coin, this.config.longExchange === 'Lighter');
                    let shortSymbol = Helpers.getUnifiedSymbol(this.config.shortExchange, this.config.coin, this.config.shortExchange === 'Lighter');

                    if (this.config.longExchange === 'Lighter') {
                        const id = await this.lighterDataService.getMarketId(longSymbol, this.config.userId);
                        if (id !== null) longSymbol = id.toString();
                    }
                    if (this.config.shortExchange === 'Lighter') {
                        const id = await this.lighterDataService.getMarketId(shortSymbol, this.config.userId);
                        if (id !== null) shortSymbol = id.toString();
                    }

                    // Переподключаем
                    await Promise.all([
                        this.activeLongTicker.start(longSymbol, (_, ask: string) => {
                            this.currentLongAsk = parseFloat(ask);
                        }),
                        this.activeShortTicker.start(shortSymbol, (bid: string, _) => {
                            this.currentShortBid = parseFloat(bid);
                        })
                    ]);

                    await onUpdate(`✅ WebSocket переподключен`);
                    this.waitingForPricesCount = 0;

                } catch (e: any) {
                    await onUpdate(`❌ Ошибка переподключения: ${e.message}. Остановка.`);
                    this.stop('WebSocket reconnection failed');
                    this.config.onFinished();
                    return;
                }
            }

            if (onStatusUpdate) {
                await onStatusUpdate({
                    filledQty: this.filledQuantity, totalQty: totalQuantity,
                    longAsk: this.currentLongAsk || 0, shortBid: this.currentShortBid || 0,
                    currentBp: 0, status: 'WAITING_PRICES'
                });
            }
            this.stepTimeout = setTimeout(() => this.runStep(), 1000);
            return;
        } else {
            // Сбрасываем счетчик, если цены есть
            this.waitingForPricesCount = 0;
        }

        // B. Расчет BP
        const currentMarketBp = ((this.currentShortBid - this.currentLongAsk) / this.currentShortBid) * 10000;

        if (onStatusUpdate) {
            await onStatusUpdate({
                filledQty: this.filledQuantity, totalQty: totalQuantity,
                longAsk: this.currentLongAsk, shortBid: this.currentShortBid,
                currentBp: currentMarketBp,
                status: currentMarketBp < targetBp ? 'WAITING_BP' : 'TRADING'
            });
        }

        // C. Условие входа
        if (currentMarketBp < targetBp) {
            this.consecutiveErrors = 0;
            this.stepTimeout = setTimeout(() => this.runStep(), 1000);
            return;
        }

        // D. Расчет объема
        let remaining = Helpers.roundFloat(totalQuantity - this.filledQuantity);
        if (remaining <= 0.0001) {
            await this.finishTrade();
            return;
        }
        const qtyToTrade = Helpers.roundFloat(Math.min(stepQuantity, remaining), 3);

        await onUpdate(`⚡️ <b>Итерация #${this.iteration}</b> (BP: ${currentMarketBp.toFixed(1)})\nВход ${qtyToTrade}...`);

        try {
            // ПРОВЕРКА ПЕРЕД ОТПРАВКОЙ ОРДЕРОВ (C1 FIX)
            if (this.isStopping) {
                await onUpdate('🛑 Остановка запрошена. Сделка отменена.');
                return;
            }

            // E. ТРЕЙД
            const [longRes, shortRes] = await Promise.all([
                Helpers.executeTrade(this.config.longExchange, this.config.coin, 'BUY', qtyToTrade, this.services, this.config.userId),
                Helpers.executeTrade(this.config.shortExchange, this.config.coin, 'SELL', qtyToTrade, this.services, this.config.userId)
            ]);

            // ВТОРАЯ ПРОВЕРКА (на случай остановки во время исполнения)
            if (this.isStopping) {
                await onUpdate('⚠️ <b>ВНИМАНИЕ:</b> Остановка во время сделки! Проверьте позиции!');
                return;
            }

            // F. ОШИБКИ (CRITICAL LEG RISK)
            // F. ОШИБКИ (CRITICAL LEG RISK)
            if (!longRes.success && shortRes.success) {
                // H7 FIX: Critical Logging
                CriticalLogger.log('CRITICAL_LEG_FAILURE', {
                    userId: this.config.userId,
                    type: 'LONG_FAILED_SHORT_OPEN',
                    longError: longRes.error,
                    qty: qtyToTrade
                });
                throw new Error(`🛑 <b>CRITICAL:</b> SHORT открыт, LONG упал (${longRes.error})!\n⚠️ <b>ЗАКРОЙТЕ SHORT ВРУЧНУЮ!</b>`);
            }
            if (longRes.success && !shortRes.success) {
                // H7 FIX: Critical Logging
                CriticalLogger.log('CRITICAL_LEG_FAILURE', {
                    userId: this.config.userId,
                    type: 'SHORT_FAILED_LONG_OPEN',
                    shortError: shortRes.error,
                    qty: qtyToTrade
                });
                throw new Error(`🛑 <b>CRITICAL:</b> LONG открыт, SHORT упал (${shortRes.error})!\n⚠️ <b>ЗАКРОЙТЕ LONG ВРУЧНУЮ!</b>`);
            }
            if (!longRes.success && !shortRes.success) {
                // Not critical (nothing opened), but good to log maybe? Audit didn't specify.
                throw new Error(`Оба ордера failed. L: ${longRes.error}, S: ${shortRes.error}`);
            }

            // G. УСПЕХ
            this.consecutiveErrors = 0;
            const longPrice = longRes.price!;
            const shortPrice = shortRes.price!;
            const realizedBp = ((shortPrice - longPrice) / shortPrice) * 10000; // Расчет реального BP

            this.filledQuantity = Helpers.roundFloat(this.filledQuantity + qtyToTrade);

            // === HEALTH BUFFER LOGIC ===
            const bpDiff = realizedBp - this.config.targetBp;
            const isTradeGood = bpDiff >= -this.ALLOWED_BP_SLIPPAGE;

            this.bpHealthBuffer.shift();
            this.bpHealthBuffer.push(isTradeGood);
            const bufferVisual = this.bpHealthBuffer.map(ok => ok ? '✅' : '❌').join(' ');

            await onUpdate(
                `🎉 <b>Шаг #${this.iteration} OK</b> | ${this.filledQuantity}/${totalQuantity}\n` +
                `📈 L (${this.config.longExchange}): <b>${longPrice.toFixed(4)}</b>\n` +
                `📉 S (${this.config.shortExchange}): <b>${shortPrice.toFixed(4)}</b>\n` +
                `📊 Real BP: <b>${realizedBp.toFixed(1)}</b>\n` +
                `Health: [ ${bufferVisual} ]`
            );

            this.iteration++;

            // Аварийная остановка если все 3 трейда плохие
            if (!this.bpHealthBuffer.includes(true)) {
                throw new Error(`🛑 <b>АВАРИЙНАЯ ОСТАНОВКА!</b>\n3 трейда подряд с плохим BP.`);
            }

            if (this.filledQuantity >= totalQuantity) {
                await this.finishTrade();
                return;
            }

            this.stepTimeout = setTimeout(() => this.runStep(), 1500);

        } catch (err: any) {
            this.consecutiveErrors++;
            console.error(`[AutoTrade Error] Iteration failed (${this.consecutiveErrors}):`, err.message);

            if (err.message.includes('CRITICAL')) {
                await onUpdate(err.message);
                this.stop('Critical Error');
                this.config.onFinished();
                return;
            }

            // ОБРАБОТКА АВАРИЙНОЙ ОСТАНОВКИ (Health Buffer)
            // Если в буфере нет ни одной успешной сделки (все false) - останавливаемся
            if (!this.bpHealthBuffer.includes(true)) {
                await onUpdate(`⛔️ <b>АВАРИЙНАЯ ОСТАНОВКА!</b>\n3 трейда подряд с плохим BP.`);
                await this.finishTrade();
                return;
            }

            if (this.consecutiveErrors > 5) {
                await onUpdate(`❌ <b>Слишком много ошибок подряд. Остановка.</b>`);
                this.stop('Too many errors');
                this.config.onFinished();
                return;
            }

            await onUpdate(`⚠️ Ошибка шага: ${err.message}. Повтор...`);
            this.stepTimeout = setTimeout(() => this.runStep(), 2000);
        }
    }

    private async finishTrade() {
        const { onUpdate, onStatusUpdate, onFinished, longExchange, shortExchange, coin, totalQuantity } = this.config;

        if (onStatusUpdate) {
            await onStatusUpdate({
                filledQty: this.filledQuantity, totalQty: totalQuantity,
                longAsk: 0, shortBid: 0, currentBp: 0,
                status: 'FINISHED'
            });
        }

        await onUpdate('🏁 <b>Трейд завершен.</b> Сверка позиций...');

        try {
            const [longPos, shortPos] = await Promise.all([
                Helpers.getPositionData(longExchange, coin, this.services, this.config.userId),
                Helpers.getPositionData(shortExchange, coin, this.services, this.config.userId)
            ]);

            let msg = '';
            if (longPos.size === 0 && shortPos.size === 0) {
                msg = `⚠️ <b>Позиции = 0!</b>`;
            } else {
                const diff = Math.abs(longPos.size - shortPos.size);
                const finalBp = ((shortPos.price - longPos.price) / shortPos.price) * 10000;
                msg = `✅ <b>УСПЕХ!</b>\n📦 ${longPos.size.toFixed(2)} ${coin}\nL: ${longPos.price.toFixed(6)} | S: ${shortPos.price.toFixed(6)}\n📊 <b>Avg Entry BP: ${finalBp.toFixed(1)}</b>`;
                if (diff > totalQuantity * 0.05) msg += `\n⚠️ <b>РАССИНХРОН: ${diff.toFixed(4)}</b>`;
            }
            await onUpdate(msg);
        } catch (e: any) {
            await onUpdate(`❌ API Error (Check positions manually): ${e.message}`);
        }

        this.stop('Finished');
        onFinished();
    }

    public stop(reason: string) {
        this.isStopping = true;
        if (this.stepTimeout) clearTimeout(this.stepTimeout);

        try {
            if (this.activeLongTicker) this.activeLongTicker.stop();
            if (this.activeShortTicker) this.activeShortTicker.stop();
        } catch (e) { }

        this.activeLongTicker = null;
        this.activeShortTicker = null;
        this.logger.log(`Session stopped. Reason: ${reason}`);
    }
}
