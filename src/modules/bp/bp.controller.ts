import { Context, Markup } from 'telegraf';
import { BpService } from './bp.service';
import { ExchangeName, BpCalculationData } from './bp.types';

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

    /**
     * Метод, который вызывает main.ts, чтобы узнать, нужно ли перехватывать текст юзера.
     * Возвращает true, если юзер сейчас в процессе настройки (вводит монету).
     */
    public isUserInBpFlow(userId: number): boolean {
        const state = this.userState.get(userId);
        // Перехватываем текст, только если стейт есть и мы НЕ в режиме расчета (т.е. настраиваем)
        return !!state && state.step !== 'calculating';
    }

    public async handleBpCommand(ctx: Context): Promise<void> {
        if (!ctx.from) return;
        const userId = ctx.from.id;
        const currentState = this.userState.get(userId);

        // Кнопка Вкл/Выкл (Тоггл)
        if (currentState) {
            // Если пользователь был в процессе настройки, сообщаем о сбросе
            if (currentState.step !== 'calculating') {
                this.userState.delete(userId);
                await ctx.reply('🔄 Ввод сброшен. Нажмите /bp заново.');
            } else {
                await this.stopCalculation(ctx, userId);
            }
            return;
        }

        // Начинаем новый флоу
        this.userState.set(userId, { step: 'awaiting_coin' });
        await ctx.reply('Введите тикер (например ETH):');
    }

    public async handleCoinInput(ctx: Context): Promise<void> {
        if (!ctx.from || !ctx.message || !('text' in ctx.message)) return;
        const userId = ctx.from.id;
        const state = this.userState.get(userId);

        // Если стейта нет или мы не ждем ввод монеты - игнорируем
        if (!state || state.step !== 'awaiting_coin') return;

        const coin = ctx.message.text.trim().toUpperCase();

        // Валидация тикера (2-10 символов, буквы/цифры)
        if (!/^[A-Z0-9]{2,10}$/.test(coin)) {
            await ctx.reply('❌ Некорректный тикер. Попробуйте еще раз (например: BTC).');
            return;
        }

        state.coin = coin;
        state.step = 'awaiting_long';

        const keyboard = Markup.inlineKeyboard(
            ALL_EXCHANGES.map(ex => Markup.button.callback(ex, `bp_long_${ex}`))
        );
        await ctx.reply(`Монета: <b>${coin}</b>.\nВыберите биржу для <b>LONG</b>:`, { parse_mode: 'HTML', ...keyboard });
    }

    public async handleCallbackQuery(ctx: Context): Promise<void> {
        if (!ctx.from || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
        try { await ctx.answerCbQuery(); } catch { }

        const userId = ctx.from.id;
        const state = this.userState.get(userId);
        const data = ctx.callbackQuery.data;

        if (!state || !data.startsWith('bp_')) return;

        const parts = data.split('_');
        const step = parts[1]; // long / short
        const exchange = parts[2] as ExchangeName;

        // Удаляем кнопки у старого сообщения
        try { await ctx.editMessageReplyMarkup(undefined); } catch { }

        if (step === 'long' && state.step === 'awaiting_long') {
            state.longExchange = exchange;
            state.step = 'awaiting_short';

            await ctx.reply(`✅ Long: ${exchange}`);

            // Исключаем выбранную биржу из списка для шорта
            const remaining = ALL_EXCHANGES.filter(e => e !== exchange);
            const keyboard = Markup.inlineKeyboard(
                remaining.map(ex => Markup.button.callback(ex, `bp_short_${ex}`))
            );
            await ctx.reply(`Выберите биржу для <b>SHORT</b>:`, { parse_mode: 'HTML', ...keyboard });

        } else if (step === 'short' && state.step === 'awaiting_short') {
            state.shortExchange = exchange;
            state.step = 'calculating';

            await ctx.reply(`✅ Short: ${exchange}`);
            const msg = await ctx.reply(`⏳ <b>Подключение...</b>\n${state.coin}: ${state.longExchange} vs ${exchange}`, { parse_mode: 'HTML' });
            state.messageId = msg.message_id;

            // Запускаем сессию в фоне
            this.startSession(ctx, userId);
        }
    }

    private async startSession(ctx: Context, userId: number) {
        const state = this.userState.get(userId);
        if (!state || !state.coin || !state.longExchange || !state.shortExchange) return;

        const onUpdate = async (data: BpCalculationData | null) => {
            const current = this.userState.get(userId);

            // Если юзер нажал стоп, но апдейт прилетел — выходим
            if (!current || current.step !== 'calculating' || !current.messageId) return;

            // === ЗАЩИТА ОТ БАНА TELEGRAM (4 сек) ===
            const now = Date.now();
            if (current.lastUpdateTime && now - current.lastUpdateTime < 4000) return;

            let text = '';
            if (data === null) {
                text = `⏳ <b>${current.coin}</b>\nОжидание данных...`;
            } else {
                const dateStr = new Date().toLocaleTimeString('ru-RU');
                text = `📊 <b>${current.coin} BP MONITOR</b> [${dateStr}]\n\n` +
                    `📈 L (${current.longExchange}): <b>${data.longPrice}</b>\n` +
                    `📉 S (${current.shortExchange}): <b>${data.shortPrice}</b>\n` +
                    `---------------------------\n` +
                    `💰 <b>BP: ${data.bpValue.toFixed(2)}</b>`;
            }

            if (text === current.lastMessageText) return;

            current.lastMessageText = text;
            current.lastUpdateTime = now;

            try {
                await ctx.telegram.editMessageText(userId, current.messageId, undefined, text, { parse_mode: 'HTML' });
            } catch (err: any) {
                // Если сообщение не найдено или юзер блокнул бота
                if (err.description?.includes('message to edit not found') || err.description?.includes('blocked')) {
                    this.stopCalculation(ctx, userId);
                }
                // Игнорируем 429 ошибки, просто пропускаем такт обновления
                if (err.description?.includes('Too Many Requests')) {
                    console.warn(`[BpController] Rate limit hit for user ${userId}`);
                }
            }
        };

        try {
            await this.bpService.startSession(
                userId,
                state.coin,
                state.longExchange,
                state.shortExchange,
                onUpdate
            );
        } catch (e: any) {
            // H8 FIX: Останавливаем сервис при ошибке запуска
            this.bpService.stopSession(userId);
            this.userState.delete(userId);
            if (state.messageId) {
                try {
                    await ctx.telegram.editMessageText(userId, state.messageId, undefined, `❌ Ошибка: ${e.message}`);
                } catch { }
            }
        }
    }

    private async stopCalculation(ctx: Context, userId: number) {
        const state = this.userState.get(userId);

        // 1. Останавливаем сервис (закрываем сокеты)
        this.bpService.stopSession(userId);

        // 2. Чистим память контроллера
        this.userState.delete(userId);

        // 3. Обновляем UI
        // Если была активная таблица - помечаем её как 'завершенную', но новое сообщение шлем вниз
        if (state && state.messageId && state.step === 'calculating') {
            try {
                await ctx.telegram.editMessageText(userId, state.messageId, undefined, '� <b>Мониторинг BP завершен.</b>', { parse_mode: 'HTML' });
            } catch { }
        }

        // Всегда отправляем НОВОЕ сообщение вниз (после текста команды 'bp')
        await ctx.reply('🛑 Мониторинг остановлен.');
    }
}