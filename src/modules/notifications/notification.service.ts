import * as cron from 'node-cron';
import { Telegraf } from 'telegraf';

// Для имитации вашего сервиса, например, для Binance
class MockBinanceService {
    private equity = 10000;

    // Имитация падения маржи через 20 секунд после запуска
    constructor() {
        setTimeout(() => {
            this.equity = 700; // Маржа упала
        }, 10000);
    }

    async getAccountEquity(): Promise<number> {
        // В реальном приложении здесь будет HTTP-запрос к API
        console.log('Проверка equity, текущее значение:', this.equity);
        return this.equity;
    }
}
function escapeMarkdownV2(text: string): string {
    const specialChars = /[_*[\]()~`>#+\-=|{}.!]/g;
    return text.replace(specialChars, '\\$&');
}

export class NotificationService {
    // Хранилище для активных задач мониторинга. Ключ - chat.id, значение - задача node-cron.
    private activeMonitors = new Map<number, cron.ScheduledTask>();
    private mockBinanceService = new MockBinanceService();

    constructor(private bot: Telegraf) { }

    /**
     * Запускает мониторинг для указанного чата.
     * @param chatId ID чата для отправки уведомлений.
     */
    public startMarginMonitoring(chatId: number): boolean {
        if (this.activeMonitors.has(chatId)) {
            return false; // Мониторинг уже запущен
        }

        // Запускаем задачу каждые 5 секунд.
        const task = cron.schedule('*/5 * * * * *', async () => {
            console.log(`[${new Date().toLocaleTimeString()}] Запущена проверка маржи для чата ${chatId}`);

            try {
                const equity = await this.mockBinanceService.getAccountEquity();
                const marginThreshold = 1000; // Пороговое значение

                if (equity < marginThreshold) {
                    const message = `🚨 *ВНИМАНИЕ* 🚨\n\nМаржа опустилась ниже порога\\!\n*Текущее значение*: ${escapeMarkdownV2(equity.toString())}`;

                    // Отправляем уведомление пользователю
                    await this.bot.telegram.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
                }
            } catch (error) {
                console.error('Ошибка при проверке маржи:', error);
                // Можно также отправить уведомление об ошибке пользователю
            }
        });

        this.activeMonitors.set(chatId, task);
        console.log(`Мониторинг запущен для чата ${chatId}`);
        return true;
    }

    /**
     * Останавливает мониторинг для указанного чата.
     * @param chatId ID чата.
     */
    public stopMarginMonitoring(chatId: number): boolean {
        const task = this.activeMonitors.get(chatId);

        if (task) {
            task.stop();
            this.activeMonitors.delete(chatId);
            console.log(`Мониторинг остановлен для чата ${chatId}`);
            return true;
        }

        return false; // Мониторинг не был запущен
    }
}