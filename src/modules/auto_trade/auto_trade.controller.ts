import { Context, Markup } from 'telegraf';
import { AutoTradeService, ExchangeName } from './auto_trade.service';

interface AutoTradeState {
    step: 'coin' | 'long_ex' | 'short_ex' | 'total_qty' | 'step_qty' | 'bp' | 'running';
    coin?: string;
    longEx?: ExchangeName;
    shortEx?: ExchangeName;
    totalQty?: number;
    stepQty?: number;
    targetBp?: number;
}

const EXCHANGES: ExchangeName[] = ['Binance', 'Hyperliquid', 'Paradex', 'Extended', 'Lighter'];

// Клавиатура нужна только для восстановления при ошибках или остановке
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

    // === ЛОГИКА КНОПКИ OPEN POS ===
    public async handleOpenPosCommand(ctx: Context) {
        if (!ctx.from) return;
        const userId = ctx.from.id;

        // 1. ОСТАНОВКА ТОРГОВЛИ
        if (this.autoTradeService.isRunning(userId)) {
            this.autoTradeService.stopSession(userId, 'Остановлено кнопкой OPEN POS');
            await ctx.reply('🛑 <b>Набор остановлен вручную.</b>', {
                parse_mode: 'HTML',
                // На всякий случай обновляем клавиатуру при стопе
                ...MAIN_KEYBOARD
            });
            this.userStates.delete(userId);
            return;
        }

        // 2. ОТМЕНА ВВОДА
        if (this.isUserInFlow(userId)) {
            this.userStates.delete(userId);
            await ctx.reply('🚫 <b>Ввод данных отменен.</b>\nМожете начать заново.', {
                parse_mode: 'HTML'
                // Не трогаем клавиатуру, она и так есть
            });
            return;
        }

        // 3. НОВЫЙ ВВОД
        this.userStates.set(userId, { step: 'coin' });

        // Мы НЕ удаляем клавиатуру. Она останется внизу.
        await ctx.reply('\n1️⃣ Введите тикер монеты (например, ETH):', {
            parse_mode: 'HTML'
        });
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
                    if (!/^[a-zA-Z0-9]{2,10}$/.test(text)) {
                        return ctx.reply('❌ Некорректный тикер. Попробуйте снова.');
                    }
                    state.coin = text.toUpperCase();
                    state.step = 'long_ex';

                    // Тут отправляем Inline кнопки. Главная клавиатура останется под ними.
                    await ctx.reply(`Монета: <b>${state.coin}</b>.\n2️⃣ Выберите биржу для <b>LONG</b>:`, {
                        parse_mode: 'HTML',
                        ...this.getExchangeKeyboard('at_long')
                    });
                    break;

                case 'total_qty':
                    const tQty = parseFloat(text);
                    if (isNaN(tQty) || tQty <= 0) return ctx.reply('❌ Введите число > 0');
                    state.totalQty = tQty;
                    state.step = 'step_qty';

                    // Просто текст. Клавиатура не прыгает.
                    await ctx.reply(`Всего: ${tQty}.\n5️⃣ Введите размер <b>одного шага</b> (ордера):`, {
                        parse_mode: 'HTML'
                    });
                    break;

                case 'step_qty':
                    const sQty = parseFloat(text);
                    if (isNaN(sQty) || sQty <= 0) return ctx.reply('❌ Введите число > 0');
                    if (sQty > state.totalQty!) return ctx.reply('❌ Шаг не может быть больше общего количества!');
                    state.stepQty = sQty;
                    state.step = 'bp';

                    await ctx.reply(`Шаг: ${sQty}.\n6️⃣ Введите желаемый <b>BP</b> для трейда (например, 10):`, {
                        parse_mode: 'HTML'
                    });
                    break;

                case 'bp':
                    const bp = parseFloat(text);
                    if (isNaN(bp)) return ctx.reply('❌ Введите число');
                    state.targetBp = bp;

                    // ЗАПУСК
                    await this.startTrade(ctx, userId);
                    break;
            }
        } catch (e) {
            console.error(e);
            ctx.reply('Ошибка ввода.');
        }
    }

    public async handleCallback(ctx: Context) {
        if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
        const data = ctx.callbackQuery.data;
        const userId = ctx.from!.id;
        const state = this.userStates.get(userId);

        if (!state) return;

        if (data.startsWith('at_long_')) {
            state.longEx = data.replace('at_long_', '') as ExchangeName;
            state.step = 'short_ex';

            await ctx.editMessageText(`Long: <b>${state.longEx}</b>.\n3️⃣ Выберите биржу для <b>SHORT</b>:`, {
                parse_mode: 'HTML',
                ...this.getExchangeKeyboard('at_short', state.longEx)
            });
        }
        else if (data.startsWith('at_short_')) {
            state.shortEx = data.replace('at_short_', '') as ExchangeName;
            state.step = 'total_qty';

            // Убираем инлайн кнопки у старого сообщения
            await ctx.editMessageText(`Выбрано: Long <b>${state.longEx}</b> | Short <b>${state.shortEx}</b>`, { parse_mode: 'HTML', reply_markup: undefined });

            // Новое сообщение БЕЗ указания клавиатуры (она останется старая)
            await ctx.reply(`4️⃣ Введите <b>ОБЩЕЕ</b> количество монет для набора:`, {
                parse_mode: 'HTML'
            });
        }
        await ctx.answerCbQuery();
    }

    private getExchangeKeyboard(prefix: string, exclude?: string) {
        const available = exclude ? EXCHANGES.filter(e => e !== exclude) : EXCHANGES;
        const buttons = available.map(e => Markup.button.callback(e, `${prefix}_${e}`));
        return Markup.inlineKeyboard(buttons, { columns: 5 });
    }

    private async startTrade(ctx: Context, userId: number) {
        const state = this.userStates.get(userId)!;
        state.step = 'running';

        await ctx.reply('⏳ <b>Инициализация...</b>\n<i>Для остановки нажмите кнопку "OPEN POS" еще раз.</i>', {
            parse_mode: 'HTML'
            // Тут тоже можно не слать клавиатуру, если она и так есть.
            // Но если вдруг юзер её удалил, можно вернуть: ...MAIN_KEYBOARD
        });

        this.autoTradeService.startSession({
            userId,
            coin: state.coin!,
            longExchange: state.longEx!,
            shortExchange: state.shortEx!,
            totalQuantity: state.totalQty!,
            stepQuantity: state.stepQty!,
            targetBp: state.targetBp!,
            onUpdate: async (text) => {
                // При логах клавиатуру не трогаем
                try { await ctx.reply(text, { parse_mode: 'HTML' }); } catch { }
            },
            onFinished: () => {
                this.userStates.delete(userId);
            }
        });
    }
}