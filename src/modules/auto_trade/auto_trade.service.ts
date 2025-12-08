import { Injectable, Logger } from '@nestjs/common';
import { BinanceTickerService } from '../binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from '../hyperliquid/websocket/hyperliquid.ticker.service';
import { ParadexTickerService } from '../paradex/websocket/paradex.ticker.service';
import { ExtendedTickerService } from '../extended/websocket/extended.ticker.service';

import { BinanceService } from '../binance/binance.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { ParadexService } from '../paradex/paradex.service';
import { ExtendedService } from '../extended/extended.service';

import * as Helpers from './auto_trade.helpers';

export type ExchangeName = 'Binance' | 'Hyperliquid' | 'Paradex' | 'Extended' | 'Lighter';

// Допустимое отклонение BP в худшую сторону
const ALLOWED_BP_SLIPPAGE = 300;

// Интерфейс данных для живого дашборда
export interface TradeStatusData {
    filledQty: number;
    totalQty: number;
    longAsk: number;
    shortBid: number;
    currentBp: number;
    status: 'WAITING_PRICES' | 'WAITING_BP' | 'TRADING' | 'FINISHED';
}

export interface TradeSessionConfig {
    userId: number;
    coin: string;
    longExchange: ExchangeName;
    shortExchange: ExchangeName;
    totalQuantity: number;
    stepQuantity: number;
    targetBp: number;
    // Обычные логи (новые сообщения)
    onUpdate: (msg: string) => Promise<void>;
    // Живой статус (редактирование одного сообщения)
    onStatusUpdate?: (data: TradeStatusData) => Promise<void>;
    onFinished: () => void;
}

@Injectable()
export class AutoTradeService {
    private readonly logger = new Logger(AutoTradeService.name);
    private activeSessions = new Map<number, boolean>();
    private activeSockets = new Map<number, { long: any, short: any, timeout: NodeJS.Timeout | null }>();

    constructor(
        private binanceTicker: BinanceTickerService,
        private hlTicker: HyperliquidTickerService,
        private paradexTicker: ParadexTickerService,
        private extendedTicker: ExtendedTickerService,

        private binanceService: BinanceService,
        private hlService: HyperliquidService,
        private paradexService: ParadexService,
        private extendedService: ExtendedService,
    ) { }

    private get services() {
        return {
            binance: this.binanceService,
            hl: this.hlService,
            paradex: this.paradexService,
            extended: this.extendedService
        };
    }

    public isRunning(userId: number): boolean {
        return !!this.activeSessions.get(userId);
    }

    public stopSession(userId: number, reason: string = 'Unknown') {
        if (this.activeSockets.has(userId)) {
            const socketData = this.activeSockets.get(userId)!;
            if (socketData.timeout) clearTimeout(socketData.timeout);
            try {
                if (socketData.long?.stop) socketData.long.stop();
                if (socketData.short?.stop) socketData.short.stop();
            } catch (e) {
                console.error(`[AutoTrade] Error stopping sockets:`, e);
            }
            this.activeSockets.delete(userId);
        }
        this.activeSessions.delete(userId);
        this.logger.log(`Session stopped for user ${userId}. Reason: ${reason}`);
    }

    public async startSession(config: TradeSessionConfig) {
        const { userId, coin, longExchange, shortExchange, totalQuantity, stepQuantity, targetBp, onUpdate, onStatusUpdate, onFinished } = config;

        // Валидация
        if (this.isRunning(userId)) return onUpdate('⚠️ У вас уже запущен процесс.');
        if (totalQuantity <= 0 || stepQuantity <= 0) return onUpdate('❌ Ошибка: Количество <= 0');
        if (stepQuantity > totalQuantity) return onUpdate('❌ Ошибка: Шаг > Всего');

        this.activeSessions.set(userId, true);

        const bpHealthBuffer: boolean[] = [true, true, true];
        let filledQuantity = 0;
        let iteration = 1;
        let currentLongAsk: number | null = null;
        let currentShortBid: number | null = null;

        // Лог старта (новое сообщение)
        await onUpdate(
            `🚀 <b>СТАРТ СЕССИИ</b>\n` +
            `Монета: <b>${coin}</b>\n` +
            `Long: ${longExchange} | Short: ${shortExchange}`
        );

        try {
            const longSymbol = await Helpers.formatSymbol(longExchange, coin);
            const shortSymbol = await Helpers.formatSymbol(shortExchange, coin);

            const longTicker = this.getTickerService(longExchange);
            const shortTicker = this.getTickerService(shortExchange);

            await Promise.all([
                longTicker.start(longSymbol, (_: string, ask: string) => { currentLongAsk = parseFloat(ask); }),
                shortTicker.start(shortSymbol, (bid: string, _: string) => { currentShortBid = parseFloat(bid); })
            ]);

            this.activeSockets.set(userId, { long: longTicker, short: shortTicker, timeout: null });

            // === ГЛАВНЫЙ ЦИКЛ ===
            const runStep = async () => {
                if (!this.isRunning(userId)) return;

                // A. Ожидание цен
                if (!currentLongAsk || !currentShortBid) {
                    // Шлем статус, что ждем цены
                    if (onStatusUpdate) {
                        await onStatusUpdate({
                            filledQty: filledQuantity, totalQty: totalQuantity,
                            longAsk: 0, shortBid: 0, currentBp: 0,
                            status: 'WAITING_PRICES'
                        });
                    }
                    const t = setTimeout(runStep, 1000);
                    this.updateSocketTimeout(userId, t);
                    return;
                }

                // B. Расчет BP
                const currentMarketBp = ((currentShortBid! - currentLongAsk!) / currentShortBid!) * 10000;

                // --- ОТПРАВЛЯЕМ ОБНОВЛЕНИЕ ДАШБОРДА ---
                if (onStatusUpdate) {
                    await onStatusUpdate({
                        filledQty: filledQuantity,
                        totalQty: totalQuantity,
                        longAsk: currentLongAsk!,
                        shortBid: currentShortBid!,
                        currentBp: currentMarketBp,
                        status: currentMarketBp < targetBp ? 'WAITING_BP' : 'TRADING'
                    });
                }

                // C. ПРОВЕРКА BP (Если низкий - ждем)
                if (currentMarketBp < targetBp) {
                    const t = setTimeout(runStep, 1000);
                    this.updateSocketTimeout(userId, t);
                    return;
                }

                // D. Расчет объема
                let remaining = Helpers.roundFloat(totalQuantity - filledQuantity);
                if (remaining <= 0.0001) {
                    await this.finishTrade(config, filledQuantity);
                    return;
                }
                const qtyToTrade = Helpers.roundFloat(Math.min(stepQuantity, remaining), 3);
                if (qtyToTrade <= 0) {
                    await this.finishTrade(config, filledQuantity);
                    return;
                }

                // Лог итерации (новое сообщение)
                await onUpdate(`⚡️ <b>Итерация #${iteration}</b> (BP: ${currentMarketBp.toFixed(1)})\nВход ${qtyToTrade} ${coin}...`);

                try {
                    // E. ТРЕЙД
                    const [longRes, shortRes] = await Promise.all([
                        Helpers.executeTrade(longExchange, coin, 'BUY', qtyToTrade, this.services),
                        Helpers.executeTrade(shortExchange, coin, 'SELL', qtyToTrade, this.services)
                    ]);

                    // F. ОШИБКИ
                    if (!longRes.success && !shortRes.success) throw new Error(`Оба ордера failed.\nL: ${longRes.error}\nS: ${shortRes.error}`);
                    if (!longRes.success && shortRes.success) throw new Error(`🛑 <b>CRITICAL:</b> SHORT открыт, LONG упал!\n⚠️ <b>ЗАКРОЙТЕ SHORT ВРУЧНУЮ!</b>`);
                    if (longRes.success && !shortRes.success) throw new Error(`🛑 <b>CRITICAL:</b> LONG открыт, SHORT упал!\n⚠️ <b>ЗАКРОЙТЕ LONG ВРУЧНУЮ!</b>`);

                    // G. АНАЛИЗ
                    const longPrice = longRes.price!;
                    const shortPrice = shortRes.price!;
                    const realizedBp = ((shortPrice - longPrice) / shortPrice) * 10000;

                    filledQuantity = Helpers.roundFloat(filledQuantity + qtyToTrade);

                    const bpDiff = realizedBp - targetBp;
                    const isTradeGood = bpDiff >= -ALLOWED_BP_SLIPPAGE;

                    bpHealthBuffer.shift();
                    bpHealthBuffer.push(isTradeGood);
                    const bufferVisual = bpHealthBuffer.map(ok => ok ? '✅' : '❌').join(' ');

                    // Лог успеха (новое сообщение)
                    await onUpdate(
                        `🎉 <b>Шаг #${iteration} OK</b> | ${filledQuantity}/${totalQuantity}\n` +
                        `Real BP: <b>${realizedBp.toFixed(1)}</b>\n` +
                        `Health: [ ${bufferVisual} ]`
                    );

                    iteration++;

                    if (!bpHealthBuffer.includes(true)) {
                        throw new Error(`🛑 <b>АВАРИЙНАЯ ОСТАНОВКА!</b>\n3 трейда подряд с плохим BP.`);
                    }

                    if (filledQuantity >= totalQuantity) {
                        await this.finishTrade(config, filledQuantity);
                        return;
                    }

                    // Пауза перед следующей итерацией
                    await onUpdate('⏳ Пауза 1 сек...');
                    const t = setTimeout(runStep, 1000);
                    this.updateSocketTimeout(userId, t);

                } catch (err: any) {
                    await onUpdate(`❌ <b>ОШИБКА:</b> ${err.message}\n🔴 <b>ТРЕЙД ОСТАНОВЛЕН</b>`);
                    this.stopSession(userId, 'Error in loop');
                    onFinished();
                }
            };

            runStep();

        } catch (error: any) {
            await onUpdate(`❌ Start Error: ${error.message}`);
            this.stopSession(userId, 'Start error');
            onFinished();
        }
    }

    private async finishTrade(config: TradeSessionConfig, filledQty: number) {
        const { userId, coin, longExchange, shortExchange, onUpdate, onStatusUpdate, onFinished } = config;

        // Финальное обновление дашборда
        if (onStatusUpdate) {
            // (Опционально) можно послать статус FINISHED, чтобы контроллер понял
        }

        await onUpdate('🏁 <b>Трейд завершен.</b> Сверка позиций...');

        try {
            const [longPos, shortPos] = await Promise.all([
                Helpers.getPositionData(longExchange, coin, this.services),
                Helpers.getPositionData(shortExchange, coin, this.services)
            ]);

            let msg = '';
            if (longPos.size === 0 && shortPos.size === 0) {
                msg = `⚠️ <b>Позиции = 0!</b>`;
            } else if (longPos.size === 0 || shortPos.size === 0) {
                msg = `⚠️ <b>ОДНОЙ ПОЗЫ НЕТ!</b>\nL: ${longPos.size} | S: ${shortPos.size}`;
            } else {
                const diff = Math.abs(longPos.size - shortPos.size);
                if (diff > config.totalQuantity * 0.01) {
                    msg = `⚠️ <b>РАССИНХРОН!</b>\nL: ${longPos.size} | S: ${shortPos.size}\nDiff: ${diff.toFixed(4)}`;
                } else {
                    const finalBp = ((shortPos.price - longPos.price) / shortPos.price) * 10000;
                    msg = `✅ <b>УСПЕХ!</b>\n📦 ${longPos.size.toFixed(2)} ${coin}\nL: ${longPos.price} | S: ${shortPos.price.toFixed(2)}\n📊 <b>Avg Entry BP: ${finalBp.toFixed(1)}</b>`;
                }
            }
            await onUpdate(msg);
        } catch (e: any) {
            await onUpdate(`❌ API Error: ${e.message}`);
        }

        this.stopSession(userId, 'Finished');
        onFinished();
    }

    private updateSocketTimeout(userId: number, t: NodeJS.Timeout) {
        const s = this.activeSockets.get(userId);
        if (s) s.timeout = t;
    }

    private getTickerService(exchange: ExchangeName): any {
        switch (exchange) {
            case 'Binance': return this.binanceTicker;
            case 'Hyperliquid': return this.hlTicker;
            case 'Paradex': return this.paradexTicker;
            case 'Extended': return this.extendedTicker;
            default: throw new Error(`No ticker for ${exchange}`);
        }
    }
}