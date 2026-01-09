import { Context, Markup } from 'telegraf';
import { PayBackService } from './payback.service';
import { ExchangeName } from '../bp/bp.types';
import { PayBackState } from './payback.types';

const ALL_EXCHANGES: ExchangeName[] = ['Binance', 'Hyperliquid', 'Paradex', 'Extended', 'Lighter'];

export class PayBackController {
    private userStates = new Map<number, PayBackState>();

    constructor(private readonly payBackService: PayBackService) { }

    public isUserInFlow(userId: number): boolean {
        const state = this.userStates.get(userId);
        return !!state && state.step !== 'calculating';
    }

    public async handlePayBackCommand(ctx: Context): Promise<void> {
        if (!ctx.from) return;
        const userId = ctx.from.id;

        if (this.payBackService.isSessionActive(userId)) {
            this.payBackService.stopSession(userId);
            this.userStates.delete(userId);
            await ctx.reply('🛑 Расчет окупаемости остановлен.');
            return;
        }

        this.userStates.set(userId, { step: 'awaiting_coin' });
        await ctx.reply('🔍 <b>Тест Окупаемости Монеты (1 мин)</b>\nВведите тикер монеты (например: BTC):', { parse_mode: 'HTML' });
    }

    public async handleTextInput(ctx: Context): Promise<void> {
        if (!ctx.from || !ctx.message || !('text' in ctx.message)) return;
        const userId = ctx.from.id;
        const state = this.userStates.get(userId);

        if (!state || state.step !== 'awaiting_coin') return;

        const coin = ctx.message.text.trim().toUpperCase();
        if (!/^[A-Z0-9]{2,10}$/.test(coin)) {
            await ctx.reply('❌ Некорректный тикер. Попробуйте еще раз.');
            return;
        }

        state.coin = coin;
        state.step = 'awaiting_long';

        const keyboard = Markup.inlineKeyboard(
            ALL_EXCHANGES.map(ex => Markup.button.callback(ex, `payback_long_${ex}`))
        );
        await ctx.reply(`Монета: <b>${coin}</b>\nВыберите биржу для <b>LONG</b>:`, { parse_mode: 'HTML', ...keyboard });
    }

    public async handleCallbackQuery(ctx: Context): Promise<void> {
        if (!ctx.from || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
        const data = ctx.callbackQuery.data;
        if (!data.startsWith('payback_')) return;

        try { await ctx.answerCbQuery(); } catch { }

        const userId = ctx.from.id;


        const state = this.userStates.get(userId);
        if (!state) return;

        const parts = data.split('_');
        const action = parts[1]; // long/short
        const exchange = parts[2] as ExchangeName;

        try { await ctx.editMessageReplyMarkup(undefined); } catch { }

        if (action === 'long' && state.step === 'awaiting_long') {
            state.longExchange = exchange;
            state.step = 'awaiting_short';
            await ctx.reply(`✅ Long: ${exchange}`);

            const remaining = ALL_EXCHANGES.filter(e => e !== exchange);
            const keyboard = Markup.inlineKeyboard(
                remaining.map(ex => Markup.button.callback(ex, `payback_short_${ex}`))
            );
            await ctx.reply(`Выберите биржу для <b>SHORT</b>:`, { parse_mode: 'HTML', ...keyboard });
        } else if (action === 'short' && state.step === 'awaiting_short') {
            state.shortExchange = exchange;
            state.step = 'calculating';
            await ctx.reply(`✅ Short: ${exchange}\n⏳ <b>Начинаю расчет среднего БП и окупаемости (60 сек)...</b>`, { parse_mode: 'HTML' });

            try {
                await this.payBackService.startTestSession(
                    userId,
                    state.coin!,
                    state.longExchange!,
                    state.shortExchange!,
                    async (result) => {
                        this.userStates.delete(userId);
                        if (!result) {
                            await ctx.telegram.sendMessage(userId, `❌ Ошибка: не удалось получить данные для ${state.coin}.`, { parse_mode: 'HTML' });
                        } else {
                            await ctx.telegram.sendMessage(userId,
                                `📊 <b>Результат Теста Окупаемости (1 мин)</b>\n\n` +
                                `🪙 Монета: <b>${result.coin}</b>\n` +
                                `📈 Long: ${result.longExchange}\n` +
                                `📉 Short: ${result.shortExchange}\n` +
                                `--------------------------\n` +
                                `💰 <b>Средний BP: ${result.averageBp.toFixed(2)}</b>\n` +
                                `📊 APR 1D: ${result.apr1d.toFixed(2)}%\n` +
                                `📊 APR 3D: ${result.apr3d.toFixed(2)}%\n` +
                                `--------------------------\n` +
                                `💸 Расход (Comm+BP): ${result.totalCostBp.toFixed(2)} BP\n` +
                                `📈 Доход/день: ${result.dailyReturnBp.toFixed(2)} BP\n` +
                                `⏳ <b>Окупаемость: ${result.dailyReturnBp <= 0 ? 'Никогда' : result.paybackDays.toFixed(1) + ' дней'
                                }</b>`,
                                { parse_mode: 'HTML' }
                            );
                        }
                    }
                );
            } catch (err: any) {
                this.userStates.delete(userId);
                await ctx.reply(`❌ Ошибка запуска сессии: ${err.message}`);
            }
        }
    }
}
