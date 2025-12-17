import { Context, Markup } from 'telegraf';
import { BpService, ExchangeName, BpCalculationData } from './bp.service';

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

        // ЛОГИКА СБРОСА: Если есть любой стейт (ввод или расчет) — сбрасываем всё
        if (currentState) {
            await this.stopCalculation(ctx, userId);
            // Если мы были на этапе ввода (не расчета), можно отправить сообщение о сбросе
            if (currentState.step !== 'calculating') {
                await ctx.reply('🔄 Ввод данных сброшен. Нажмите /bp, чтобы начать заново.');
            }
            return;
        }

        // Если стейта нет — начинаем новый флоу
        this.userState.set(userId, { step: 'awaiting_coin' });
        await ctx.reply('Введите символ монеты (например, ETH или BTC):');
    }

    public async handleCoinInput(ctx: Context): Promise<void> {
        if (!ctx.from || !ctx.message || !('text' in ctx.message)) return;

        const userId = ctx.from.id;
        const state = this.userState.get(userId);
        if (!state) return;

        const coin = ctx.message.text.trim();

        if (!/^[a-zA-Z0-9]{1,10}$/.test(coin)) {
            await ctx.reply('❌ Неверный формат. Введите тикер (например ETH).');
            return;
        }

        const upperCoin = coin.toUpperCase();

        if (state.step === 'awaiting_coin') {
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

        try { await ctx.answerCbQuery(); } catch { }

        const userId = ctx.from.id;
        const state = this.userState.get(userId);
        const data = ctx.callbackQuery.data;

        if (!state || !data.startsWith('bp_')) return;

        const [_, step, exchangeName] = data.split('_');

        try {
            await ctx.editMessageReplyMarkup(undefined);
        } catch { }

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
            const initialMessage = await ctx.reply(`⏳ <b>Подключение...</b>\nМонета: ${state.coin}`, { parse_mode: 'HTML' });
            state.messageId = initialMessage.message_id;

            // Запускаем расчет (без await, чтобы не блокировать хендлер)
            this.startCalculation(ctx, userId);
        }
    }

    private async startCalculation(ctx: Context, userId: number): Promise<void> {
        const state = this.userState.get(userId);
        if (!state || !state.coin || !state.longExchange || !state.shortExchange || !state.messageId) return;

        const onUpdate = async (data: BpCalculationData | null) => {
            const currentState = this.userState.get(userId);
            if (!currentState || currentState.step !== 'calculating') return;

            const now = Date.now();
            if (currentState.lastUpdateTime && now - currentState.lastUpdateTime < 1500) return; // Троттлинг 1.5с

            let text: string;

            if (data === null) {
                text = `⏳ <b>${currentState.coin} BP</b>\nWaiting for data...`;
            } else {
                text = `📊 <b>${currentState.coin} BP MONITOR</b>\n\n` +
                    `📈 Long (${currentState.longExchange}): <b>${data.longPrice.toFixed(4)}</b>\n` +
                    `📉 Short (${currentState.shortExchange}): <b>${data.shortPrice.toFixed(4)}</b>\n` +
                    `---------------------------\n` +
                    `💰 <b>BP: ${data.bpValue.toFixed(2)}</b>`;
            }

            if (text === currentState.lastMessageText) return;

            currentState.lastMessageText = text;
            currentState.lastUpdateTime = now;

            try {
                await ctx.telegram.editMessageText(userId, currentState.messageId!, undefined, text, { parse_mode: 'HTML' });
            } catch (error: any) {
                if (error.description?.includes('message is not modified')) return;
                if (error.description?.includes('message to edit not found')) {
                    this.stopCalculation(ctx, userId);
                }
            }
        };

        try {
            await this.bpService.start(state.coin, state.longExchange, state.shortExchange, onUpdate);
        } catch (error) {
            const errorMessage = (error as Error).message;
            // ЛОГИКА ОСТАНОВКИ ПРИ ОШИБКЕ
            // Если сервис упал (throw из start), мы чистим стейт и пишем ошибку

            // Удаляем стейт, чтобы service.stop() не вызывался дважды (хотя там есть защита)
            this.userState.delete(userId);

            if (state.messageId) {
                try {
                    await ctx.telegram.editMessageText(
                        userId, state.messageId, undefined,
                        `❌ <b>Ошибка запуска:</b>\n${errorMessage}\n\nПопробуйте /bp еще раз.`,
                        { parse_mode: 'HTML' }
                    );
                } catch { }
            }
        }
    }

    private async stopCalculation(ctx: Context, userId: number): Promise<void> {
        const state = this.userState.get(userId);

        // 1. Останавливаем сервис (закрываем сокеты)
        this.bpService.stop();

        // 2. Чистим память
        this.userState.delete(userId);

        // 3. Информируем пользователя
        if (state) {
            // Если шел расчет, меняем сообщение монитора
            if (state.step === 'calculating' && state.messageId) {
                try {
                    await ctx.telegram.editMessageText(
                        userId, state.messageId, undefined,
                        '🛑 <b>Расчет BP остановлен.</b>',
                        { parse_mode: 'HTML' }
                    );
                } catch (e) {
                    await ctx.reply('🛑 Расчет BP остановлен.');
                }
            }
            // Сообщение "Ввод сброшен" обрабатывается в handleBpCommand для UX
        }
    }
}