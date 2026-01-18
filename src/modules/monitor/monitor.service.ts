import { BpService } from '../bp/bp.service';
import { MonitorTask, MonitorInput, EXCHANGE_MAP, ExchangeCode } from './monitor.types';

export class MonitorService {
    // Храним задачи в виде Map: "userId_coin_long_short" -> Task
    private activeTasks = new Map<string, MonitorTask>();

    constructor(private readonly bpService: BpService) { }

    public startMonitoring(
        userId: number,
        inputs: MonitorInput[],
        interval: number,
        duration: number,
        onReport: (message: string) => Promise<void>
    ) {
        for (const input of inputs) {
            const longEx = EXCHANGE_MAP[input.longExCode.toLowerCase()];
            const shortEx = EXCHANGE_MAP[input.shortExCode.toLowerCase()];
            const taskId = `${userId}_${input.coin}_${input.longExCode}_${input.shortExCode}`.toUpperCase();

            // Если такая задача уже есть, остановим старую
            if (this.activeTasks.has(taskId)) {
                this.stopTask(taskId);
            }

            const task: MonitorTask = {
                userId,
                coin: input.coin,
                longEx,
                shortEx,
                intervalMin: interval,
                totalDurationMin: Math.min(duration, 120),
                startTime: Date.now()
            };

            // Запускаем первый цикл сразу
            this.runCycle(task, onReport);

            // Устанавливаем интервал
            task.timer = setInterval(() => {
                const elapsed = (Date.now() - task.startTime) / (60 * 1000);
                if (elapsed >= task.totalDurationMin) {
                    this.stopTask(taskId);
                    onReport(`🏁 Мониторинг <b>${task.coin}</b> (${task.longEx}/${task.shortEx}) завершен по времени.`);
                    return;
                }
                this.runCycle(task, onReport);
            }, interval * 60 * 1000);

            this.activeTasks.set(taskId, task);
        }
    }

    private async runCycle(task: MonitorTask, onReport: (message: string) => Promise<void>) {
        let values: number[] = [];

        // Callback для сбора данных
        const collect = (data: any) => {
            if (data && data.bpValue !== undefined) {
                values.push(data.bpValue);
            }
        };

        const tag = `monitor_${task.coin}_${task.longEx}_${task.shortEx}`.toUpperCase();

        try {
            // Подключаемся с уникальным тегом
            await this.bpService.startSession(task.userId, task.coin, task.longEx, task.shortEx, collect, tag);

            // Ждем 60 секунд
            await new Promise(r => setTimeout(r, 60000));

            // Отключаемся
            this.bpService.stopSession(task.userId, tag);

            if (values.length > 0) {
                const avg = values.reduce((a, b) => a + b, 0) / values.length;
                const timeStr = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                const msg = `📡 <b>[Monitoring ${timeStr}]</b>\n<b>${task.coin}</b> (${task.longEx} vs ${task.shortEx})\nСредний BP за минуту: <b>${avg.toFixed(2)}</b>`;
                await onReport(msg);
            } else {
                await onReport(`⚠️ <b>[Monitoring] ${task.coin}</b>: Нет данных за минуту (проверьте подключение к сокетам).`);
            }
        } catch (e: any) {
            this.bpService.stopSession(task.userId, tag);
            console.error(`[MonitorService] Error in cycle:`, e.message);
        }
    }

    public stopUserMonitors(userId: number): string[] {
        const stoppedCoins: string[] = [];
        for (const [id, task] of this.activeTasks.entries()) {
            if (task.userId === userId) {
                this.stopTask(id);
                // Явно останавливаем сессию в BpService
                const tag = `monitor_${task.coin}_${task.longEx}_${task.shortEx}`.toUpperCase();
                this.bpService.stopSession(userId, tag);
                stoppedCoins.push(`${task.coin} (${task.longEx}/${task.shortEx})`);
            }
        }
        return stoppedCoins;
    }

    private stopTask(taskId: string) {
        const task = this.activeTasks.get(taskId);
        if (task && task.timer) {
            clearInterval(task.timer);
        }
        this.activeTasks.delete(taskId);
    }

    public hasActiveMonitors(userId: number): boolean {
        for (const task of this.activeTasks.values()) {
            if (task.userId === userId) return true;
        }
        return false;
    }
}
