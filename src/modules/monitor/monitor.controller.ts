import { Context } from 'telegraf';
import { MonitorService } from './monitor.service';
import { MonitorInput, ExchangeCode, EXCHANGE_MAP } from './monitor.types';

interface MonitorState {
    step: 'awaiting_coins' | 'awaiting_timing';
    pendingInputs?: MonitorInput[];
}

export class MonitorController {
    private userStates = new Map<number, MonitorState>();

    constructor(private readonly monitorService: MonitorService) { }

    public isUserInFlow(userId: number): boolean {
        return this.userStates.has(userId);
    }

    public async handleMonitorCommand(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        // 1. Если пользователь в процессе настройки (вводит монеты или время) - отменяем ввод
        if (this.userStates.has(userId)) {
            this.userStates.delete(userId);
            await ctx.reply('🔄 <b>Ввод мониторинга отменен.</b>', { parse_mode: 'HTML' });
            return;
        }

        // 2. Если уже запущен мониторинг — останавливаем все задачи этого пользователя
        if (this.monitorService.hasActiveMonitors(userId)) {
            const stopped = this.monitorService.stopUserMonitors(userId);
            await ctx.reply(`🛑 <b>Мониторинг остановлен для:</b>\n${stopped.join('\n')}`, { parse_mode: 'HTML' });
            return;
        }

        this.userStates.set(userId, { step: 'awaiting_coins' });
        await ctx.reply('🔍 <b>Настройка мониторинга</b>\n\nВведите монеты и биржи в формате:\n<code>DOLO BH, ZORA PL</code>\n(где B=Binance, H=HL, P=Paradex, E=Extended, L=Lighter)', { parse_mode: 'HTML' });
    }

    public async handleTextInput(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId || !ctx.message || !('text' in ctx.message)) return;

        const state = this.userStates.get(userId);
        if (!state) return;

        const text = ctx.message.text.trim();

        if (state.step === 'awaiting_coins') {
            const inputs = this.parseCoins(text);
            if (inputs.length === 0) {
                await ctx.reply('❌ Некорректный формат. Попробуйте еще раз:\nНапр: <code>DOLO BH, ZORA PL</code>', { parse_mode: 'HTML' });
                return;
            }
            state.pendingInputs = inputs;
            state.step = 'awaiting_timing';
            await ctx.reply('⏱ <b>Введите периодичность и длительность</b>\n\nПример: <code>5 60</code> (каждые 5 мин в течении часа).\nЕсли ввести одно число, запуск будет на 60 минут.\n(Макс. длительность — 120 мин)', { parse_mode: 'HTML' });
            return;
        }

        if (state.step === 'awaiting_timing') {
            const parts = text.split(/\s+/).map(Number);
            const interval = parts[0];
            let duration = parts[1] || 60;

            if (isNaN(interval) || interval <= 0) {
                await ctx.reply('❌ Введите корректные числа через пробел (напр. 5 60).');
                return;
            }

            if (duration > 120) duration = 120;

            const inputs = state.pendingInputs!;
            this.userStates.delete(userId);

            await ctx.reply(`🚀 <b>Запуск мониторинга...</b>\nМонет: ${inputs.length}\nИнтервал: ${interval} мин\nДлительность: ${duration} мин`, { parse_mode: 'HTML' });

            this.monitorService.startMonitoring(userId, inputs, interval, duration, async (msg) => {
                await ctx.telegram.sendMessage(userId, msg, { parse_mode: 'HTML' });
            });
        }
    }

    private parseCoins(text: string): MonitorInput[] {
        const result: MonitorInput[] = [];
        const pairs = text.split(',').map(s => s.trim()).filter(Boolean);

        for (const pair of pairs) {
            const parts = pair.split(/\s+/);
            if (parts.length < 2) continue;

            const coin = parts[0].toUpperCase();
            const exchanges = parts[1].toLowerCase();

            if (exchanges.length !== 2) continue;

            const e1 = exchanges[0] as ExchangeCode;
            const e2 = exchanges[1] as ExchangeCode;

            if (EXCHANGE_MAP[e1] && EXCHANGE_MAP[e2]) {
                result.push({ coin, longExCode: e1.toUpperCase() as ExchangeCode, shortExCode: e2.toUpperCase() as ExchangeCode });
            }
        }
        return result;
    }
}
