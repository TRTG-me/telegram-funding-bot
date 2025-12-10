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

        if (currentState && currentState.step === 'calculating') {
            await this.stopCalculation(ctx, userId);
        } else {
            this.userState.set(userId, { step: 'awaiting_coin' });
            await ctx.reply('Введите символ монеты (например, ETH или BTC):');
        }
    }

    public async handleCoinInput(ctx: Context): Promise<void> {
        if (!ctx.from || !ctx.message || !('text' in ctx.message)) return;

        const userId = ctx.from.id;
        const state = this.userState.get(userId);
        if (!state) return; // Защита от потери стейта

        const coin = ctx.message.text.trim();

        if (!/^[a-zA-Z0-9]{1,10}$/.test(coin)) { // Чуть расширил регулярку для 1000PEPE
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

        // Сразу отвечаем, чтобы убрать часики
        try { await ctx.answerCbQuery(); } catch { }

        const userId = ctx.from.id;
        const state = this.userState.get(userId);
        const data = ctx.callbackQuery.data;

        if (!state || !data.startsWith('bp_')) return;

        const [_, step, exchangeName] = data.split('_');

        // Редактируем сообщение с кнопками, чтобы они пропали
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

            this.startCalculation(ctx, userId);
        }
    }

    private async startCalculation(ctx: Context, userId: number): Promise<void> {
        const state = this.userState.get(userId);
        if (!state || !state.coin || !state.longExchange || !state.shortExchange || !state.messageId) return;

        const onUpdate = async (data: BpCalculationData | null) => {
            const currentState = this.userState.get(userId);
            // Если пользователь нажал стоп, но колбэк еще прилетел
            if (!currentState || currentState.step !== 'calculating') return;

            const now = Date.now();
            // Троттлинг 2 сек (Безопасно для ТГ)
            if (currentState.lastUpdateTime && now - currentState.lastUpdateTime < 1000) return;

            let text: string;

            if (data === null) {
                text = `⏳ <b>${currentState.coin} BP</b>\nWaiting for data...`;
            } else {
                // Красивое форматирование
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
                // Игнорируем стандартные ошибки "не изменилось"
                if (error.description?.includes('message is not modified')) return;

                // Если сообщение не найдено (юзер удалил), останавливаем расчет
                if (error.description?.includes('message to edit not found')) {
                    this.stopCalculation(ctx, userId);
                }

                console.error('Failed to edit BP message:', error.message);
            }
        };

        try {
            await this.bpService.start(state.coin, state.longExchange, state.shortExchange, onUpdate);
        } catch (error) {
            const errorMessage = (error as Error).message;
            // Пытаемся сообщить об ошибке
            if (state.messageId) {
                try {
                    await ctx.telegram.editMessageText(
                        userId, state.messageId, undefined,
                        `❌ <b>Ошибка запуска:</b>\n${errorMessage}`,
                        { parse_mode: 'HTML' }
                    );
                } catch { }
            }
            this.userState.delete(userId);
        }
    }

    private async stopCalculation(ctx: Context, userId: number): Promise<void> {
        const state = this.userState.get(userId);
        this.bpService.stop();
        this.userState.delete(userId);

        if (state && state.messageId) {
            try {
                await ctx.telegram.editMessageText(userId, state.messageId, undefined, '🛑 <b>Расчет BP остановлен.</b>', { parse_mode: 'HTML' });
            } catch (e) {
                await ctx.reply('🛑 Расчет BP остановлен.');
            }
        } else {
            await ctx.reply('🛑 Расчет BP остановлен.');
        }
    }
}