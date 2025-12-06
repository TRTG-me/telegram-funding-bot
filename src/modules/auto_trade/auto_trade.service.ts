import { Injectable, Logger } from '@nestjs/common';
import { BinanceTickerService } from '../binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from '../hyperliquid/websocket/hyperliquid.ticker.service';
import { ParadexTickerService } from '../paradex/websocket/paradex.ticker.service'; // <--- NEW

import { BinanceService } from '../binance/binance.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { ParadexService } from '../paradex/paradex.service'; // <--- NEW

import * as Helpers from './auto_trade.helpers';

export type ExchangeName = 'Binance' | 'Hyperliquid' | 'Paradex' | 'Extended' | 'Lighter';

// Допустимое отклонение BP в худшую сторону (проскальзывание)
const ALLOWED_BP_SLIPPAGE = 3;

export interface TradeSessionConfig {
    userId: number;
    coin: string;
    longExchange: ExchangeName;
    shortExchange: ExchangeName;
    totalQuantity: number;
    stepQuantity: number;
    targetBp: number;
    onUpdate: (msg: string) => Promise<void>;
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
        private paradexTicker: ParadexTickerService, // <--- NEW

        private binanceService: BinanceService,
        private hlService: HyperliquidService,
        private paradexService: ParadexService, // <--- NEW
    ) { }

    // Передаем все сервисы в хелпер
    private get services() {
        return {
            binance: this.binanceService,
            hl: this.hlService,
            paradex: this.paradexService // <--- NEW
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
        const { userId, coin, longExchange, shortExchange, totalQuantity, stepQuantity, targetBp, onUpdate, onFinished } = config;

        // 1. ВАЛИДАЦИЯ
        if (this.isRunning(userId)) return onUpdate('⚠️ У вас уже запущен процесс.');
        if (totalQuantity <= 0 || stepQuantity <= 0) return onUpdate('❌ Ошибка: Количество <= 0');
        if (stepQuantity > totalQuantity) return onUpdate('❌ Ошибка: Шаг > Всего');

        this.activeSessions.set(userId, true);

        // Буфер здоровья BP (3 последних трейда). True = OK, False = Bad.
        const bpHealthBuffer: boolean[] = [true, true, true];

        let filledQuantity = 0;
        let iteration = 1;
        let currentLongAsk: number | null = null;
        let currentShortBid: number | null = null;

        await onUpdate(
            `🚀 <b>СТАРТ</b>\n` +
            `Монета: <b>${coin}</b>\n` +
            `Target BP: <b>${targetBp}</b> (Allowed slip: -${ALLOWED_BP_SLIPPAGE})\n` +
            `Long: ${longExchange} | Short: ${shortExchange}\n` +
            `Vol: ${totalQuantity} (step ${stepQuantity})`
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

            // === ЦИКЛ ===
            const runStep = async () => {
                if (!this.isRunning(userId)) return;

                // A. Ожидание цен
                if (!currentLongAsk || !currentShortBid) {
                    const t = setTimeout(runStep, 1000);
                    this.updateSocketTimeout(userId, t);
                    return;
                }

                // B. Расчет текущего рыночного BP
                const currentMarketBp = ((currentShortBid! - currentLongAsk!) / currentShortBid!) * 10000;

                // C. ПРОВЕРКА УСЛОВИЯ ВХОДА (BP >= Target)
                if (currentMarketBp < targetBp) {
                    const t = setTimeout(runStep, 1000); // Ждем 1 сек
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

                await onUpdate(`⚡️ <b>Итерация #${iteration}</b> (Market BP: ${currentMarketBp.toFixed(1)})\nВход ${qtyToTrade} ${coin}...`);

                try {
                    // E. ВЫПОЛНЕНИЕ ТРЕЙДОВ (Параллельно)
                    const [longRes, shortRes] = await Promise.all([
                        Helpers.executeTrade(longExchange, coin, 'BUY', qtyToTrade, this.services),
                        Helpers.executeTrade(shortExchange, coin, 'SELL', qtyToTrade, this.services)
                    ]);

                    // F. ОБРАБОТКА ОШИБОК ИСПОЛНЕНИЯ
                    if (!longRes.success && !shortRes.success) throw new Error(`Оба ордера failed.\nL: ${longRes.error}\nS: ${shortRes.error}`);

                    if (!longRes.success && shortRes.success) throw new Error(`🛑 <b>CRITICAL:</b> SHORT открыт (${shortRes.price}), LONG упал (${longRes.error})!\n⚠️ <b>ЗАКРОЙТЕ SHORT ВРУЧНУЮ!</b>`);

                    if (longRes.success && !shortRes.success) throw new Error(`🛑 <b>CRITICAL:</b> LONG открыт (${longRes.price}), SHORT упал (${shortRes.error})!\n⚠️ <b>ЗАКРОЙТЕ LONG ВРУЧНУЮ!</b>`);

                    // G. АНАЛИЗ РЕЗУЛЬТАТА
                    const longPrice = longRes.price!;
                    const shortPrice = shortRes.price!;
                    const realizedBp = ((shortPrice - longPrice) / shortPrice) * 10000;

                    filledQuantity = Helpers.roundFloat(filledQuantity + qtyToTrade);

                    // --- ПРОВЕРКА КАЧЕСТВА BP ---
                    const bpDiff = realizedBp - targetBp;
                    const isTradeGood = bpDiff >= -ALLOWED_BP_SLIPPAGE;

                    bpHealthBuffer.shift();
                    bpHealthBuffer.push(isTradeGood);

                    const bufferVisual = bpHealthBuffer.map(ok => ok ? '✅' : '❌').join(' ');

                    await onUpdate(
                        `🎉 <b>Шаг #${iteration} OK</b> | ${filledQuantity}/${totalQuantity}\n` +
                        `BP: <b>${realizedBp.toFixed(1)}</b> (Target: ${targetBp})\n` +
                        `Health: [ ${bufferVisual} ]`
                    );

                    iteration++;

                    // --- ПРОВЕРКА НА ОСТАНОВКУ (3 Fails подряд) ---
                    if (!bpHealthBuffer.includes(true)) {
                        throw new Error(`🛑 <b>АВАРИЙНАЯ ОСТАНОВКА!</b>\n3 трейда подряд с плохим BP.\nПоследний: ${realizedBp.toFixed(1)} (Target ${targetBp})`);
                    }

                    if (filledQuantity >= totalQuantity) {
                        await this.finishTrade(config, filledQuantity);
                        return;
                    }

                    await onUpdate(`⏳ Пауза 1 сек...`);
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
        const { userId, coin, longExchange, shortExchange, onUpdate, onFinished } = config;
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
                    msg = `✅ <b>УСПЕХ!</b>\n📦 ${longPos.size.toFixed(2)} ${coin}\nL: ${longPos.price} | S: ${shortPos.price.toFixed(2)}\n📊 <b>Entry BP: ${finalBp.toFixed(1)}</b>`;
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
            case 'Paradex': return this.paradexTicker; // <--- NEW
            default: throw new Error(`No ticker for ${exchange}`);
        }
    }
}