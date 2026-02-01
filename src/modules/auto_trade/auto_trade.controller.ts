import { Context, Markup } from 'telegraf';
import { AutoTradeService } from './auto_trade.service';
import { ExchangeName, TradeStatusData } from './auto_trade.types'; // ИМПОРТ ТИПОВ
import { telegramQueue } from '../../common/telegram.queue'; // C4 FIX
import { tradeBotKeyboard } from '../../common/keyboards';

interface AutoTradeState {
    step: 'coin' | 'long_ex' | 'short_ex' | 'total_qty' | 'step_qty' | 'step_warning' | 'bp' | 'running';
    coin?: string;
    longEx?: ExchangeName;
    shortEx?: ExchangeName;
    totalQty?: number;
    stepQty?: number;
    targetBp?: number;

    statusMessageId?: number;
    lastStatusText?: string;
    lastUpdateTime?: number;

    messageQueue: string[];
    isProcessingQueue: boolean;
    coinPrice?: number;
    coinPriceUsd?: number;
}

const EXCHANGES: ExchangeName[] = ['Binance', 'Hyperliquid', 'Paradex', 'Extended', 'Lighter'];


export class AutoTradeController {
    private userStates = new Map<number, AutoTradeState>();
    private userStateTimestamps = new Map<number, number>();
    private processingUsers = new Set<number>(); // C7 FIX
    private cleanupInterval: NodeJS.Timeout;
    private readonly MAX_STEP_USD = 350; // Лимит на один шаг в долларах

    constructor(private readonly autoTradeService: AutoTradeService) {
        // Запускаем очистку каждую минуту (C3 FIX)
        this.cleanupInterval = setInterval(() => this.cleanupStaleStates(), 60000);
    }

    private cleanupStaleStates() {
        const now = Date.now();
        const STALE_TIMEOUT = 600_000; // 10 минут

        for (const [userId, timestamp] of this.userStateTimestamps.entries()) {
            if (now - timestamp > STALE_TIMEOUT) {
                const state = this.userStates.get(userId);

                // Если пользователь не в активной торговле
                if (state && state.step !== 'running') {
                    console.log(`[AutoTrade] Cleaning stale state for user ${userId}`);
                    this.userStates.delete(userId);
                    this.userStateTimestamps.delete(userId);
                }
            }
        }
    }

    public isUserInFlow(userId: number): boolean {
        const state = this.userStates.get(userId);
        return !!state && state.step !== 'running';
    }

    // --- ОЧЕРЕДЬ СООБЩЕНИЙ (C4 FIX) ---
    private enqueueMessage(userId: number, text: string, ctx: Context) {
        // Используем глобальную очередь
        telegramQueue.add(
            async () => {
                await ctx.telegram.sendMessage(userId, text, { parse_mode: 'HTML' });
            },
            1 // Приоритет: обычный
        );
    }

    // --- ОБРАБОТЧИКИ ---

    public async handleOpenPosCommand(ctx: Context) {
        if (!ctx.from) return;
        const userId = ctx.from.id;

        // C7 FIX: Защита от двойного клика
        if (this.processingUsers.has(userId)) {
            await ctx.reply('⏳ Команда уже обрабатывается. Подождите...');
            return;
        }

        this.processingUsers.add(userId); // 🔒 БЛОКИРОВКА

        try {
            const state = this.userStates.get(userId);

            // FIX: Если статус 'running', значит сессия активна (даже если isRunning врет/задержка).
            // Останавливаем принудительно.
            // Код оптимизирован: все проверки состояния объединены ниже

            if (state || this.autoTradeService.isRunning(userId)) {
                // Если сессия запущена - останавливаем её
                if (this.autoTradeService.isRunning(userId)) {
                    this.autoTradeService.stopSession(userId, 'Остановлено кнопкой OPEN POS');
                    await ctx.reply('🛑 <b>Набор остановлен вручную.</b>', { parse_mode: 'HTML', ...tradeBotKeyboard });
                } else if (state && state.step !== 'running') {
                    // Если просто в процессе ввода - отменяем ввод
                    await ctx.reply('🚫 <b>Ввод данных отменен.</b>', { parse_mode: 'HTML', ...tradeBotKeyboard });
                }

                this.userStates.delete(userId);
                this.userStateTimestamps.delete(userId);
                this.processingUsers.delete(userId);
                return;
            }

            this.userStates.set(userId, {
                step: 'coin',
                messageQueue: [],
                isProcessingQueue: false
            });
            this.userStateTimestamps.set(userId, Date.now()); // C3 FIX
            await ctx.reply('\nВведите тикер монеты (например, ETH):', { parse_mode: 'HTML' });

        } finally {
            // 🔓 РАЗБЛОКИРОВКА через 2 секунды (защита от спама)
            setTimeout(() => {
                this.processingUsers.delete(userId);
            }, 2000);
        }
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
                    await ctx.reply(`Монета: <b>${state.coin}</b>.\nВыберите биржу для <b>LONG</b>:`, { parse_mode: 'HTML', ...this.getExchangeKeyboard('at_long') });
                    break;
                case 'total_qty':
                    const tQty = parseFloat(text);
                    if (isNaN(tQty) || tQty <= 0) return ctx.reply('❌ Введите число > 0');
                    state.totalQty = tQty;
                    state.step = 'step_qty';
                    await ctx.reply(`Всего: ${tQty}.\nВведите размер <b>одного шага</b>:`, { parse_mode: 'HTML' });
                    break;
                case 'step_qty':
                    const sQty = parseFloat(text);
                    if (isNaN(sQty) || sQty <= 0) return ctx.reply('❌ Введите число > 0');
                    if (sQty > state.totalQty!) return ctx.reply('❌ Шаг больше общего!');

                    // Проверка на лимит шага
                    const stepUsd = sQty * (state.coinPrice || 0);
                    state.stepQty = sQty; // Сохраняем в любом случае для расчета

                    if (stepUsd > this.MAX_STEP_USD) {
                        state.step = 'step_warning';
                        await ctx.reply(`⚠️ <b>ВНИМАНИЕ!</b> Размер шага (<b>$${stepUsd.toFixed(2)}</b>) превышает лимит в <b>$${this.MAX_STEP_USD}</b>.\n\nХотите продолжить с данным шагом?`, {
                            parse_mode: 'HTML',
                            ...Markup.inlineKeyboard([
                                [
                                    Markup.button.callback('Да', 'at_step_warn_yes'),
                                    Markup.button.callback('Нет', 'at_step_warn_no')
                                ]
                            ])
                        });
                    } else {
                        state.step = 'bp';
                        await ctx.reply(`Шаг: ${sQty}.\nВведите желаемый <b>BP</b>:`, { parse_mode: 'HTML' });
                    }
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
            await ctx.editMessageText(`Long: <b>${state.longEx}</b>.\nВыберите биржу для <b>SHORT</b>:`, { parse_mode: 'HTML', ...this.getExchangeKeyboard('at_short', state.longEx) });
        } else if (data.startsWith('at_short_')) {
            state.shortEx = data.replace('at_short_', '') as ExchangeName;
            state.step = 'total_qty';

            await ctx.editMessageText(`Выбрано: Long <b>${state.longEx}</b> | Short <b>${state.shortEx}</b>`, { parse_mode: 'HTML' });

            // Fetch price from Long exchange
            const price = await this.autoTradeService.getExchangePrice(state.longEx!, state.coin!, userId);
            if (price > 0) {
                state.coinPrice = price;
                const qtyFor300 = (300 / price).toFixed(0);
                const priceStr = price < 0.1 ? price.toFixed(8) : price.toFixed(4);
                await ctx.reply(`Цена <b>${state.coin}</b>: <b>${priceStr}$</b>\n` +
                    `На 300$: <b>${qtyFor300} ${state.coin}</b>`, { parse_mode: 'HTML' });
            } else {
                await ctx.reply(`⚠️ Цена <b>${state.coin}</b> на <b>${state.longEx}</b> не найдена.`, { parse_mode: 'HTML' });
            }

            await ctx.reply(`Введите <b>ОБЩЕЕ</b> количество монет:`, { parse_mode: 'HTML' });
        } else if (data === 'at_step_warn_yes') {
            state.step = 'bp';
            await ctx.editMessageText(`✅ Шаг подтвержден: <b>${state.stepQty}</b>\nВведите желаемый <b>BP</b>:`, { parse_mode: 'HTML' });
        } else if (data === 'at_step_warn_no') {
            state.step = 'step_qty';
            await ctx.editMessageText('🔄 Введите размер <b>одного шага</b> заново:', { parse_mode: 'HTML' });
        }
    }

    private getExchangeKeyboard(prefix: string, exclude?: string) {
        const available = exclude ? EXCHANGES.filter(e => e !== exclude) : EXCHANGES;
        const buttons = available.map(e => Markup.button.callback(e, `${prefix}_${e}`));
        return Markup.inlineKeyboard(buttons, { columns: 5 });
    }

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

            onUpdate: async (text) => {
                this.enqueueMessage(userId, text, ctx);
            },

            onStatusUpdate: async (data: TradeStatusData) => {
                const now = Date.now();
                // Защита от спама: не чаще чем раз в 2 секунды
                if (state.lastUpdateTime && now - state.lastUpdateTime < 4000) return;

                const text = this.formatDashboard(state, data);
                if (state.statusMessageId && text !== state.lastStatusText) {
                    try {
                        await ctx.telegram.editMessageText(userId, state.statusMessageId, undefined, text, { parse_mode: 'HTML' });
                        state.lastStatusText = text;
                        state.lastUpdateTime = now;
                    } catch (e: any) {
                        if (e.description?.includes('not found')) {
                            state.statusMessageId = undefined;
                        }
                    }
                }
            },

            onFinished: async () => {
                if (state.statusMessageId) {
                    try {
                        await ctx.telegram.editMessageText(userId, state.statusMessageId, undefined, '🏁 <b>Сессия завершена (см. логи).</b>', { parse_mode: 'HTML' });
                    } catch { }
                }
                // Восстанавливаем клавиатуру
                await ctx.telegram.sendMessage(userId, 'Торговля остановлена. Главное меню.', { ...tradeBotKeyboard });
                this.userStates.delete(userId);
                this.userStateTimestamps.delete(userId); // C3 FIX
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
            `Монета: <b>${state.coin}</b> (Price: <b>${state.coinPrice?.toFixed(4) ?? '...'}</b>)\n` +
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