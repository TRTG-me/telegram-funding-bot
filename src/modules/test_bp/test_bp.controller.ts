import { Context, Markup } from 'telegraf';
import { TestBpService } from './test_bp.service';
import { ExchangeName } from '../bp/bp.types';
import { TestBpState } from './test_bp.types';

const ALL_EXCHANGES: ExchangeName[] = ['Binance', 'Hyperliquid', 'Paradex', 'Extended', 'Lighter'];

export class TestBpController {
    private userStates = new Map<number, TestBpState>();

    constructor(private readonly testBpService: TestBpService) { }

    public isUserInFlow(userId: number): boolean {
        const state = this.userStates.get(userId);
        return !!state && state.step !== 'calculating';
    }

    public async handleTestBpCommand(ctx: Context): Promise<void> {
        if (!ctx.from) return;
        const userId = ctx.from.id;

        if (this.testBpService.isSessionActive(userId)) {
            this.testBpService.stopSession(userId);
            this.userStates.delete(userId);
            await ctx.reply('🛑 Тестовый расчет остановлен.');
            return;
        }

        this.userStates.set(userId, { step: 'awaiting_coin' });
        await ctx.reply('🔍 <b>Тест БП (1 минута)</b>\nВведите тикер монеты (например: ETH):', { parse_mode: 'HTML' });
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
            ALL_EXCHANGES.map(ex => Markup.button.callback(ex, `testbp_long_${ex}`))
        );
        await ctx.reply(`Монета: <b>${coin}</b>\nВыберите биржу для <b>LONG</b>:`, { parse_mode: 'HTML', ...keyboard });
    }

    public async handleCallbackQuery(ctx: Context): Promise<void> {
        if (!ctx.from || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
        const data = ctx.callbackQuery.data;
        if (!data.startsWith('testbp_')) return;

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
                remaining.map(ex => Markup.button.callback(ex, `testbp_short_${ex}`))
            );
            await ctx.reply(`Выберите биржу для <b>SHORT</b>:`, { parse_mode: 'HTML', ...keyboard });
        } else if (action === 'short' && state.step === 'awaiting_short') {
            state.shortExchange = exchange;
            state.step = 'calculating';
            await ctx.reply(`✅ Short: ${exchange}\n⏳ <b>Начинаю расчет среднего БП (60 сек)...</b>`, { parse_mode: 'HTML' });

            await this.testBpService.startTestSession(
                userId,
                state.coin!,
                state.longExchange!,
                state.shortExchange!,
                async (result) => {
                    this.userStates.delete(userId);
                    if (!result) {
                        await ctx.telegram.sendMessage(userId, `❌ Ошибка: не удалось получить корректные данные для <b>${state.coin}</b> за 60 секунд.`, { parse_mode: 'HTML' });
                    } else {
                        await ctx.telegram.sendMessage(userId,
                            `📊 <b>Результат Теста БП (1 мин)</b>\n\n` +
                            `🪙 Монета: <b>${result.coin}</b>\n` +
                            `📈 Long: ${result.longExchange}\n` +
                            `📉 Short: ${result.shortExchange}\n` +
                            `---------------------------\n` +
                            `💰 <b>Средний BP: ${result.averageBp.toFixed(2)}</b>\n` +
                            `🔢 Выборок: ${result.sampleCount}`,
                            { parse_mode: 'HTML' }
                        );
                    }
                }
            );
        }
    }
}
