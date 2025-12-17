import { Injectable, Logger } from '@nestjs/common';
import { BinanceTickerService } from '../binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from '../hyperliquid/websocket/hyperliquid.ticker.service';
import { ParadexTickerService } from '../paradex/websocket/paradex.ticker.service';
import { ExtendedTickerService } from '../extended/websocket/extended.ticker.service';
import { LighterTickerService } from '../lighter/websocket/lighter.ticker.service';

import { BinanceService } from '../binance/binance.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { ParadexService } from '../paradex/paradex.service';
import { ExtendedService } from '../extended/extended.service';
import { LighterService } from '../lighter/lighter.service';

// Импортируем helpers (убедитесь, что файл так и называется)
import * as Helpers from './auto_trade.helpers';

export type ExchangeName = 'Binance' | 'Hyperliquid' | 'Paradex' | 'Extended' | 'Lighter';

const ALLOWED_BP_SLIPPAGE = 3;

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
    onUpdate: (msg: string) => Promise<void>;
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
        private lighterTicker: LighterTickerService,

        private binanceService: BinanceService,
        private hlService: HyperliquidService,
        private paradexService: ParadexService,
        private extendedService: ExtendedService,
        private lighterService: LighterService
    ) { }

    private get services() {
        return {
            binance: this.binanceService,
            hl: this.hlService,
            paradex: this.paradexService,
            extended: this.extendedService,
            lighter: this.lighterService,
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

        // Валидация Lighter (предварительная проверка существования тикера)
        if (longExchange === 'Lighter' || shortExchange === 'Lighter') {
            try {
                // Получаем "сырой" тикер (1000BONK) для проверки
                const unified = Helpers.getUnifiedSymbol('Lighter', coin, true);
                const exists = await this.lighterService.checkSymbolExists(unified);
                if (!exists) return onUpdate(`❌ Ошибка: Монеты ${unified} нет на бирже Lighter!`);
            } catch (e: any) {
                return onUpdate(`❌ Lighter check failed: ${e.message}`);
            }
        }

        // АГРЕССИВНАЯ ОЧИСТКА ПЕРЕД СТАРТОМ
        this.stopSession(userId, 'Restart/New Session');
        await new Promise(r => setTimeout(r, 500)); // Даем время сокетам закрыться

        this.activeSessions.set(userId, true);

        const bpHealthBuffer: boolean[] = [true, true, true];
        let filledQuantity = 0;
        let iteration = 1;
        let currentLongAsk: number | null = null;
        let currentShortBid: number | null = null;
        let consecutiveErrors = 0; // Счетчик ошибок подряд

        await onUpdate(
            `🚀 <b>СТАРТ СЕССИИ</b>\n` +
            `Монета: <b>${coin}</b>\n` +
            `Long: ${longExchange} | Short: ${shortExchange}\n` +
            `Vol: ${totalQuantity}`
        );

        try {
            // --- НОВАЯ ЛОГИКА ПОЛУЧЕНИЯ СИМВОЛОВ ---

            // 1. Получаем символы через хелпер
            // Для Lighter сначала просим вернуть чистый тикер (true в конце)
            let longSymbol = Helpers.getUnifiedSymbol(longExchange, coin, longExchange === 'Lighter');
            let shortSymbol = Helpers.getUnifiedSymbol(shortExchange, coin, shortExchange === 'Lighter');

            // 2. Если биржа Lighter, ищем Market ID по чистому тикеру
            if (longExchange === 'Lighter') {
                const id = this.lighterService.getMarketId(longSymbol);
                if (id === null) throw new Error(`Market ID not found for ${longSymbol} on Lighter`);
                longSymbol = id.toString();
            }
            if (shortExchange === 'Lighter') {
                const id = this.lighterService.getMarketId(shortSymbol);
                if (id === null) throw new Error(`Market ID not found for ${shortSymbol} on Lighter`);
                shortSymbol = id.toString();
            }

            const longTicker = this.getTickerService(longExchange);
            const shortTicker = this.getTickerService(shortExchange);

            // console.log(`🔍 [Debug] Subscribing Long (${longExchange}): ${longSymbol}`);
            // console.log(`🔍 [Debug] Subscribing Short (${shortExchange}): ${shortSymbol}`);

            await Promise.all([
                longTicker.start(longSymbol, (_: string, ask: string) => {
                    currentLongAsk = parseFloat(ask);
                }),
                shortTicker.start(shortSymbol, (bid: string, _: string) => {
                    currentShortBid = parseFloat(bid);
                })
            ]);

            this.activeSockets.set(userId, { long: longTicker, short: shortTicker, timeout: null });

            // === ЦИКЛ ===
            const runStep = async () => {
                // ПРОВЕРКА 1: Сессия активна?
                if (!this.isRunning(userId)) return;

                // A. Ожидание цен
                if (!currentLongAsk || !currentShortBid) {
                    if (onStatusUpdate) {
                        await onStatusUpdate({
                            filledQty: filledQuantity, totalQty: totalQuantity,
                            longAsk: currentLongAsk || 0, shortBid: currentShortBid || 0,
                            currentBp: 0, status: 'WAITING_PRICES'
                        });
                    }
                    const t = setTimeout(runStep, 1000);
                    this.updateSocketTimeout(userId, t);
                    return;
                }

                // B. Расчет BP
                const currentMarketBp = ((currentShortBid! - currentLongAsk!) / currentShortBid!) * 10000;

                if (onStatusUpdate) {
                    await onStatusUpdate({
                        filledQty: filledQuantity, totalQty: totalQuantity,
                        longAsk: currentLongAsk!, shortBid: currentShortBid!,
                        currentBp: currentMarketBp,
                        status: currentMarketBp < targetBp ? 'WAITING_BP' : 'TRADING'
                    });
                }

                // C. Условие входа
                if (currentMarketBp < targetBp) {
                    // Сбрасываем счетчик ошибок, так как мы просто ждем
                    consecutiveErrors = 0;
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

                await onUpdate(`⚡️ <b>Итерация #${iteration}</b> (BP: ${currentMarketBp.toFixed(1)})\nВход ${qtyToTrade} ${coin}...`);

                try {
                    // E. ТРЕЙД
                    // Helpers.executeTrade сама разберется с тикерами внутри
                    const [longRes, shortRes] = await Promise.all([
                        Helpers.executeTrade(longExchange, coin, 'BUY', qtyToTrade, this.services),
                        Helpers.executeTrade(shortExchange, coin, 'SELL', qtyToTrade, this.services)
                    ]);

                    // ПРОВЕРКА 2: RACE CONDITION
                    if (!this.isRunning(userId)) {
                        console.warn('⚠️ [Race Condition] Session stopped while orders were flying!');
                        await onUpdate('⚠️ <b>ВНИМАНИЕ:</b> Остановка во время сделки! Проверьте, открылись ли позиции!');
                        return;
                    }

                    // F. ОШИБКИ (CRITICAL LEG RISK)
                    if (!longRes.success && shortRes.success) {
                        throw new Error(`🛑 <b>CRITICAL:</b> SHORT открыт, LONG упал (${longRes.error})!\n⚠️ <b>ЗАКРОЙТЕ SHORT ВРУЧНУЮ!</b>`);
                    }
                    if (longRes.success && !shortRes.success) {
                        throw new Error(`🛑 <b>CRITICAL:</b> LONG открыт, SHORT упал (${shortRes.error})!\n⚠️ <b>ЗАКРОЙТЕ LONG ВРУЧНУЮ!</b>`);
                    }
                    if (!longRes.success && !shortRes.success) {
                        // Оба упали - не критично
                        throw new Error(`Оба ордера failed. L: ${longRes.error}, S: ${shortRes.error}`);
                    }

                    // G. УСПЕХ
                    consecutiveErrors = 0;
                    const longPrice = longRes.price!;
                    const shortPrice = shortRes.price!;
                    const realizedBp = ((shortPrice - longPrice) / shortPrice) * 10000;

                    filledQuantity = Helpers.roundFloat(filledQuantity + qtyToTrade);

                    const bpDiff = realizedBp - targetBp;
                    const isTradeGood = bpDiff >= -ALLOWED_BP_SLIPPAGE;

                    bpHealthBuffer.shift();
                    bpHealthBuffer.push(isTradeGood);
                    const bufferVisual = bpHealthBuffer.map(ok => ok ? '✅' : '❌').join(' ');

                    await onUpdate(
                        `🎉 <b>Шаг #${iteration} OK</b> | ${filledQuantity}/${totalQuantity}\n` +
                        `📈 L (${longExchange}): <b>${longPrice.toFixed(4)}</b>\n` +
                        `📉 S (${shortExchange}): <b>${shortPrice.toFixed(4)}</b>\n` +
                        `📊 Real BP: <b>${realizedBp.toFixed(1)}</b>\n` +
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

                    await onUpdate('⏳ Пауза 1.5 сек...');
                    const t = setTimeout(runStep, 1500);
                    this.updateSocketTimeout(userId, t);

                } catch (err: any) {
                    consecutiveErrors++;
                    console.error(`[AutoTrade Error] Iteration failed (${consecutiveErrors}):`, err.message);

                    if (err.message.includes('CRITICAL')) {
                        await onUpdate(err.message);
                        this.stopSession(userId, 'Critical Error');
                        onFinished();
                        return;
                    }

                    if (err.message.includes('АВАРИЙНАЯ ОСТАНОВКА')) {
                        await onUpdate(`⛔️ <b>${err.message}</b>`);
                        await this.finishTrade(config, filledQuantity);
                        return;
                    }

                    if (consecutiveErrors > 5) {
                        await onUpdate(`❌ <b>Слишком много ошибок подряд (${consecutiveErrors}). Остановка.</b>\nПоследняя: ${err.message}`);
                        this.stopSession(userId, 'Too many errors');
                        onFinished();
                        return;
                    }

                    await onUpdate(`⚠️ Ошибка шага: ${err.message}. Повтор...`);
                    const t = setTimeout(runStep, 2000);
                    this.updateSocketTimeout(userId, t);
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
        const { userId, coin, longExchange, shortExchange, totalQuantity, onUpdate, onStatusUpdate, onFinished } = config;

        if (onStatusUpdate) {
            await onStatusUpdate({
                filledQty: filledQty, totalQty: totalQuantity,
                longAsk: 0, shortBid: 0, currentBp: 0,
                status: 'FINISHED'
            });
        }

        await onUpdate('🏁 <b>Трейд завершен.</b> Сверка позиций...');

        try {
            // Helpers.getPositionData тоже сама разберется с тикерами
            const [longPos, shortPos] = await Promise.all([
                Helpers.getPositionData(longExchange, coin, this.services),
                Helpers.getPositionData(shortExchange, coin, this.services)
            ]);

            let msg = '';
            if (longPos.size === 0 && shortPos.size === 0) {
                msg = `⚠️ <b>Позиции = 0!</b> (Возможно уже закрыты)`;
            } else if (longPos.size === 0 || shortPos.size === 0) {
                msg = `⚠️ <b>ОДНОЙ ПОЗЫ НЕТ!</b>\nL: ${longPos.size} | S: ${shortPos.size}`;
            } else {
                const diff = Math.abs(longPos.size - shortPos.size);
                if (diff > config.totalQuantity * 0.05) { // 5% толерантность к разнице
                    msg = `⚠️ <b>РАССИНХРОН!</b>\nL: ${longPos.size} | S: ${shortPos.size}\nDiff: ${diff.toFixed(4)}`;
                } else {
                    const finalBp = ((shortPos.price - longPos.price) / shortPos.price) * 10000;
                    msg = `✅ <b>УСПЕХ!</b>\n📦 ${longPos.size.toFixed(2)} ${coin}\nL: ${longPos.price.toFixed(6)} | S: ${shortPos.price.toFixed(6)}\n📊 <b>Avg Entry BP: ${finalBp.toFixed(1)}</b>`;
                }
            }
            await onUpdate(msg);
        } catch (e: any) {
            await onUpdate(`❌ API Error (Check positions manually): ${e.message}`);
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
            case 'Lighter': return this.lighterTicker;
            default: throw new Error(`No ticker for ${exchange}`);
        }
    }
}