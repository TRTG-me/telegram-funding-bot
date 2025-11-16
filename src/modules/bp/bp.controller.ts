import { Context, Markup } from 'telegraf';
import { Update } from 'telegraf/typings/core/types/typegram';
import { BpService, ExchangeName } from './bp.service';

interface BpState {
    step: 'awaiting_coin' | 'awaiting_long' | 'awaiting_short' | 'calculating';
    coin?: string;
    longExchange?: ExchangeName;
    shortExchange?: ExchangeName;
    messageId?: number;
    lastMessageText?: string;
    lastUpdateTime?: number;
}

const ALL_EXCHANGES: ExchangeName[] = ['Binance', 'Hyperliquid', 'Paradex', 'Extended', 'Lighter'];

export class BpController {
    private userState = new Map<number, BpState>();

    constructor(private readonly bpService: BpService) { }

    public isUserInBpFlow(userId: number): boolean {
        const state = this.userState.get(userId);
        return !!state && state.step !== 'calculating';
    }

    public async handleBpCommand(ctx: Context): Promise<void> {
        if (!ctx.from) return;
        const userId = ctx.from.id;
        const currentState = this.userState.get(userId);

        if (currentState && currentState.step === 'calculating') {
            this.stopCalculation(ctx, userId);
        } else {
            this.userState.set(userId, { step: 'awaiting_coin' });
            await ctx.reply('Введите символ монеты (например, ETH или BTC):');
        }
    }

    public async handleCoinInput(ctx: Context): Promise<void> {
        if (!ctx.from || !ctx.message || !('text' in ctx.message)) return;

        const userId = ctx.from.id;
        const state = this.userState.get(userId);
        const coin = ctx.message.text.trim();

        // --- ВАЛИДАЦИЯ ВВОДА ---
        const coinRegex = /^[a-zA-Z]{1,8}$/; // Английские буквы, от 1 до 8 символов
        if (!coinRegex.test(coin)) {
            await ctx.reply('Неверный формат. Введите символ монеты, используя только английские буквы (от 1 до 8 символов).');
            return; // Прерываем, оставляя пользователя на том же шаге
        }

        const upperCoin = coin.toUpperCase();

        if (state && state.step === 'awaiting_coin') {
            state.coin = upperCoin;
            state.step = 'awaiting_long';

            const inlineKeyboard = Markup.inlineKeyboard(
                ALL_EXCHANGES.map(name => Markup.button.callback(name, `bp_long_${name}`))
            );
            await ctx.reply('Выберите биржу для LONG позиции:', inlineKeyboard);
        }
    }

    public async handleCallbackQuery(ctx: Context): Promise<void> {
        if (!ctx.from || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;

        const userId = ctx.from.id;
        const state = this.userState.get(userId);
        const data = ctx.callbackQuery.data;

        if (!state || !data.startsWith('bp_')) return;

        const [_, step, exchangeName] = data.split('_');

        await ctx.editMessageReplyMarkup(undefined);

        if (step === 'long' && state.step === 'awaiting_long') {
            state.longExchange = exchangeName as ExchangeName;
            state.step = 'awaiting_short';
            await ctx.reply(`Выбрана биржа ${exchangeName} для LONG.`);

            const remainingExchanges = ALL_EXCHANGES.filter(ex => ex !== exchangeName);
            const inlineKeyboard = Markup.inlineKeyboard(
                remainingExchanges.map(name => Markup.button.callback(name, `bp_short_${name}`))
            );
            await ctx.reply('Выберите биржу для SHORT позиции:', inlineKeyboard);

        } else if (step === 'short' && state.step === 'awaiting_short') {
            state.shortExchange = exchangeName as ExchangeName;
            state.step = 'calculating';

            await ctx.reply(`Выбрана биржа ${exchangeName} для SHORT.`);
            const initialMessage = await ctx.reply(`⏳ Подключаюсь к биржам для расчета bp по монете ${state.coin}...`);
            state.messageId = initialMessage.message_id;

            this.startCalculation(ctx, userId);
        }
    }

    private async startCalculation(ctx: Context, userId: number): Promise<void> {
        const state = this.userState.get(userId);
        if (!state || !state.coin || !state.longExchange || !state.shortExchange || !state.messageId) return;

        const onUpdate = async (bpValue: number | null) => {
            const currentState = this.userState.get(userId);
            if (!currentState || currentState.step !== 'calculating') return;

            const now = Date.now();
            if (currentState.lastUpdateTime && now - currentState.lastUpdateTime < 500) return;

            const text = bpValue === null
                ? `*${currentState.coin} \\(${currentState.longExchange} / ${currentState.shortExchange}\\)*\n\n_Ожидание данных\\.\\.\\._`
                : `*${currentState.coin} \\(${currentState.longExchange} / ${currentState.shortExchange}\\)*\n\nbp: \`${bpValue.toFixed(1)}\``;

            if (text === currentState.lastMessageText) return;

            currentState.lastMessageText = text;
            currentState.lastUpdateTime = now;

            try {
                await ctx.telegram.editMessageText(userId, currentState.messageId!, undefined, text, { parse_mode: 'MarkdownV2' });
            } catch (error: any) {
                if (error.description !== 'Bad Request: message is not modified') {
                    console.error('Failed to edit BP message:', error);
                }
            }
        };

        try {
            // --- ОБРАБОТКА ОШИБОК ОТ СЕРВИСА ---
            await this.bpService.start(state.coin, state.longExchange, state.shortExchange, onUpdate);
        } catch (error) {
            // Если bpService выбросил ошибку (не удалось подключиться или найти монету)
            console.error(`Error caught in controller: ${(error as Error).message}`);
            await ctx.telegram.editMessageText(
                userId,
                state.messageId,
                undefined,
                `❌ *Ошибка подключения* \n\nВероятно, монета *${state.coin}* не найдена на одной из бирж, или произошла другая ошибка\\. Расчет остановлен\\.`,
                { parse_mode: 'MarkdownV2' }
            );
            // Очищаем состояние пользователя, завершая диалог
            this.userState.delete(userId);
        }
    }

    private async stopCalculation(ctx: Context, userId: number): Promise<void> {
        const state = this.userState.get(userId);
        this.bpService.stop();
        this.userState.delete(userId);

        if (state && state.messageId) {
            try {
                await ctx.telegram.editMessageText(userId, state.messageId, undefined, '✅ Расчет BP остановлен.');
            } catch (e) {
                await ctx.reply('✅ Расчет BP остановлен.');
            }
        } else {
            await ctx.reply('✅ Расчет BP остановлен.');
        }
    }
}