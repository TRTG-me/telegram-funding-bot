import { Context, Markup } from 'telegraf';
import { AutoTradeService, ExchangeName, TradeStatusData } from './auto_trade.service';

interface AutoTradeState {
    step: 'coin' | 'long_ex' | 'short_ex' | 'total_qty' | 'step_qty' | 'bp' | 'running';
    coin?: string;
    longEx?: ExchangeName;
    shortEx?: ExchangeName;
    totalQty?: number;
    stepQty?: number;
    targetBp?: number;

    // Дашборд
    statusMessageId?: number;
    lastStatusText?: string;
    lastUpdateTime?: number;

    // Очередь сообщений
    messageQueue: string[];
    isProcessingQueue: boolean;
}

const EXCHANGES: ExchangeName[] = ['Binance', 'Hyperliquid', 'Paradex', 'Extended', 'Lighter'];

const MAIN_KEYBOARD = Markup.keyboard([
    ['Плечи', 'Позиции', 'Фандинги', 'bp', 'OPEN POS'],
    ['Включить Alert', 'Выключить Alert', '✏️Изменить ранги'],
    ['🚀 Запустить тикер', '🛑 Остановить тикер']
]).resize();

export class AutoTradeController {
    private userStates = new Map<number, AutoTradeState>();

    constructor(private readonly autoTradeService: AutoTradeService) { }

    public isUserInFlow(userId: number): boolean {
        const state = this.userStates.get(userId);
        return !!state && state.step !== 'running';
    }

    // --- ОЧЕРЕДЬ СООБЩЕНИЙ (Anti-Spam) ---
    private enqueueMessage(userId: number, text: string, ctx: Context) {
        const state = this.userStates.get(userId);
        if (!state) return;

        state.messageQueue.push(text);
        if (!state.isProcessingQueue) {
            this.processQueue(userId, ctx);
        }
    }

    private async processQueue(userId: number, ctx: Context) {
        const state = this.userStates.get(userId);
        if (!state) return;

        state.isProcessingQueue = true;

        while (state.messageQueue.length > 0) {
            const text = state.messageQueue.shift(); // Берем первое
            if (text) {
                try {
                    await ctx.telegram.sendMessage(userId, text, { parse_mode: 'HTML' });
                } catch (e: any) {
                    if (e.description?.includes('Too Many Requests')) {
                        // Если 429, возвращаем в начало очереди и ждем
                        state.messageQueue.unshift(text);
                        await new Promise(r => setTimeout(r, 5000));
                    }
                }
                // Пауза между сообщениями (1 сек)
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        state.isProcessingQueue = false;
    }

    // --- ОБРАБОТЧИКИ ---

    public async handleOpenPosCommand(ctx: Context) {
        if (!ctx.from) return;
        const userId = ctx.from.id;

        // 1. ОСТАНОВКА
        if (this.autoTradeService.isRunning(userId)) {
            const state = this.userStates.get(userId);
            this.autoTradeService.stopSession(userId, 'Остановлено кнопкой OPEN POS');

            if (state && state.statusMessageId) {
                try {
                    await ctx.telegram.editMessageText(userId, state.statusMessageId, undefined, '🛑 <b>Набор остановлен вручную.</b>', { parse_mode: 'HTML' });
                } catch { }
            } else {
                await ctx.reply('🛑 <b>Набор остановлен вручную.</b>', { parse_mode: 'HTML', ...MAIN_KEYBOARD });
            }
            this.userStates.delete(userId);
            return;
        }

        // 2. СТАРТ
        if (this.isUserInFlow(userId)) {
            this.userStates.delete(userId);
            await ctx.reply('🚫 <b>Ввод данных отменен.</b>', { parse_mode: 'HTML', ...MAIN_KEYBOARD });
            return;
        }

        this.userStates.set(userId, {
            step: 'coin',
            messageQueue: [],
            isProcessingQueue: false
        });
        await ctx.reply('\n1️⃣ Введите тикер монеты (например, ETH):', { parse_mode: 'HTML' });
    }

    public async handleInput(ctx: Context) {
        if (!ctx.from || !('text' in ctx.message!)) return;
        const text = ctx.message.text.trim();
        const userId = ctx.from.id;
        const state = this.userStates.get(userId);
        if (!state) return;

        try {
            switch (state.step) {
                case 'coin':
                    if (!/^[a-zA-Z0-9]{2,10}$/.test(text)) return ctx.reply('❌ Некорректный тикер.');
                    state.coin = text.toUpperCase();
                    state.step = 'long_ex';
                    await ctx.reply(`Монета: <b>${state.coin}</b>.\n2️⃣ Выберите биржу для <b>LONG</b>:`, { parse_mode: 'HTML', ...this.getExchangeKeyboard('at_long') });
                    break;
                case 'total_qty':
                    const tQty = parseFloat(text);
                    if (isNaN(tQty) || tQty <= 0) return ctx.reply('❌ Введите число > 0');
                    state.totalQty = tQty;
                    state.step = 'step_qty';
                    await ctx.reply(`Всего: ${tQty}.\n5️⃣ Введите размер <b>одного шага</b>:`, { parse_mode: 'HTML' });
                    break;
                case 'step_qty':
                    const sQty = parseFloat(text);
                    if (isNaN(sQty) || sQty <= 0) return ctx.reply('❌ Введите число > 0');
                    if (sQty > state.totalQty!) return ctx.reply('❌ Шаг больше общего!');
                    state.stepQty = sQty;
                    state.step = 'bp';
                    await ctx.reply(`Шаг: ${sQty}.\n6️⃣ Введите желаемый <b>BP</b>:`, { parse_mode: 'HTML' });
                    break;
                case 'bp':
                    const bp = parseFloat(text);
                    if (isNaN(bp)) return ctx.reply('❌ Введите число');
                    state.targetBp = bp;
                    await this.startTrade(ctx, userId);
                    break;
            }
        } catch (e) {
            ctx.reply('Ошибка ввода.');
        }
    }

    public async handleCallback(ctx: Context) {
        if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
        try { await ctx.answerCbQuery(); } catch { }

        const data = ctx.callbackQuery.data;
        const userId = ctx.from!.id;
        const state = this.userStates.get(userId);
        if (!state) return;

        if (data.startsWith('at_long_')) {
            state.longEx = data.replace('at_long_', '') as ExchangeName;
            state.step = 'short_ex';
            await ctx.editMessageText(`Long: <b>${state.longEx}</b>.\n3️⃣ Выберите биржу для <b>SHORT</b>:`, { parse_mode: 'HTML', ...this.getExchangeKeyboard('at_short', state.longEx) });
        } else if (data.startsWith('at_short_')) {
            state.shortEx = data.replace('at_short_', '') as ExchangeName;
            state.step = 'total_qty';
            await ctx.editMessageText(`Выбрано: Long <b>${state.longEx}</b> | Short <b>${state.shortEx}</b>`, { parse_mode: 'HTML' });
            await ctx.reply(`4️⃣ Введите <b>ОБЩЕЕ</b> количество монет:`, { parse_mode: 'HTML' });
        }
    }

    private getExchangeKeyboard(prefix: string, exclude?: string) {
        const available = exclude ? EXCHANGES.filter(e => e !== exclude) : EXCHANGES;
        const buttons = available.map(e => Markup.button.callback(e, `${prefix}_${e}`));
        return Markup.inlineKeyboard(buttons, { columns: 5 });
    }

    // === ЗАПУСК ===
    private async startTrade(ctx: Context, userId: number) {
        const state = this.userStates.get(userId)!;
        state.step = 'running';

        const initMsg = await ctx.reply(
            `⏳ <b>Подключение...</b>`,
            { parse_mode: 'HTML' }
        );
        state.statusMessageId = initMsg.message_id;

        this.autoTradeService.startSession({
            userId,
            coin: state.coin!,
            longExchange: state.longEx!,
            shortExchange: state.shortEx!,
            totalQuantity: state.totalQty!,
            stepQuantity: state.stepQty!,
            targetBp: state.targetBp!,

            // А. Логи (Через очередь)
            onUpdate: async (text) => {
                this.enqueueMessage(userId, text, ctx);
            },

            // Б. Живой статус
            onStatusUpdate: async (data: TradeStatusData) => {
                const now = Date.now();
                if (state.lastUpdateTime && now - state.lastUpdateTime < 1500) return;

                const text = this.formatDashboard(state, data);
                if (state.statusMessageId && text !== state.lastStatusText) {
                    try {
                        await ctx.telegram.editMessageText(userId, state.statusMessageId, undefined, text, { parse_mode: 'HTML' });
                        state.lastStatusText = text;
                        state.lastUpdateTime = now;
                    } catch (e: any) {
                        // Если сообщение удалено пользователем, создаем новое в следующий раз
                        if (e.description?.includes('not found')) {
                            state.statusMessageId = undefined;
                        }
                    }
                }
                // Если сообщение было удалено, создаем новое (редкий кейс)
                else if (!state.statusMessageId) {
                    const newMsg = await ctx.reply(text, { parse_mode: 'HTML' });
                    state.statusMessageId = newMsg.message_id;
                }
            },

            onFinished: async () => {
                if (state.statusMessageId) {
                    try {
                        await ctx.telegram.editMessageText(userId, state.statusMessageId, undefined, '🏁 <b>Сессия завершена.</b>', { parse_mode: 'HTML' });
                    } catch { }
                }
                this.userStates.delete(userId);
            }
        });
    }

    private formatDashboard(state: AutoTradeState, data?: TradeStatusData): string {
        if (!data) return `⏳ <b>Ожидание данных...</b>`;
        let statusText = '';
        if (data.status === 'WAITING_PRICES') statusText = '🟡 Жду цены...';
        else if (data.status === 'WAITING_BP') statusText = '🟠 <b>Жду BP...</b>';
        else if (data.status === 'TRADING') statusText = '🟢 <b>ТОРГОВЛЯ</b>';
        else statusText = '🔵 Завершено';

        return `📊 <b>LIVE STATUS</b>\n` +
            `Состояние: ${statusText}\n\n` +
            `Target BP: <b>${state.targetBp}</b>\n` +
            `Current BP: <b>${data.currentBp.toFixed(2)}</b>\n` +
            `-------------------\n` +
            `📈 L (${state.longEx}): <b>${data.longAsk.toFixed(4)}</b>\n` +
            `📉 S (${state.shortEx}): <b>${data.shortBid.toFixed(4)}</b>\n` +
            `-------------------\n` +
            `Прогресс: <b>${data.filledQty.toFixed(2)} / ${state.totalQty}</b>`;
    }
}