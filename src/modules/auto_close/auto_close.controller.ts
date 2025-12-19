import { Context } from 'telegraf';
import { AutoCloseService } from './auto_close.service';

export class AutoCloseController {
    // Храним ID чата для отправки уведомлений в фоне
    private monitoringChatId: number | null = null;

    constructor(private readonly riskService: AutoCloseService) { }

    /**
     * Ручная разовая проверка (команда /check_risk или кнопка)
     */
    public async handleManualCheck(ctx: Context): Promise<void> {
        await ctx.reply('🛡 <b>Запуск ручной проверки...</b>\n(Risk + ADL Check)', { parse_mode: 'HTML' });

        try {
            // 1. Проверка РИСКОВ (Плечи)
            const { logs: riskLogs } = await this.riskService.checkAndReduceRisk();

            // 2. Проверка ADL (Hyperliquid PnL)
            // ВАЖНО: Убедись, что этот метод public в сервисе!
            const { logs: adlLogs } = await this.riskService.checkAndFixHyperliquidADL();

            // 3. Объединяем логи
            const allLogs = [...riskLogs, ...adlLogs].filter(l => !l.includes('✅ Все биржи в безопасности'));

            if (allLogs.length === 0) {
                await ctx.reply('✅ Проверка завершена. Рисков и ADL угроз нет.', { parse_mode: 'HTML' });
                return;
            }

            const message = allLogs.join('\n');
            await ctx.reply(`<b>ОТЧЕТ АВТО-ЗАКРЫТИЯ (Manual):</b>\n\n${message}`, { parse_mode: 'HTML' });

        } catch (error: any) {
            console.error('Risk Check Error:', error);
            await ctx.reply(`❌ <b>Ошибка проверки рисков:</b>\n${error.message}`, { parse_mode: 'HTML' });
        }
    }
    /**
     * Включение/Выключение мониторинга (команда /monitor или кнопка)
     */
    public async handleToggleMonitor(ctx: Context): Promise<void> {
        if (!ctx.chat) return;

        // 1. Проверяем статус (Нужно добавить геттер в сервис, см. ниже)
        const isActive = this.riskService.isMonitoringActive;

        if (isActive) {
            // === ЕСЛИ ВКЛЮЧЕНО -> ВЫКЛЮЧАЕМ ===
            this.riskService.stopMonitoring();
            this.monitoringChatId = null;
            await ctx.reply('🛑 <b>Мониторинг остановлен.</b>', { parse_mode: 'HTML' });

        } else {
            // === ЕСЛИ ВЫКЛЮЧЕНО -> ВКЛЮЧАЕМ ===
            this.monitoringChatId = ctx.chat.id;

            // Эта функция будет вызываться сервисом раз в минуту (или 20 сек)
            const sendNotification = async (msg: string) => {
                if (this.monitoringChatId) {
                    try {
                        // Используем telegram.sendMessage, так как ctx может протухнуть в интервале
                        await ctx.telegram.sendMessage(this.monitoringChatId, msg, { parse_mode: 'HTML' });
                    } catch (e) {
                        console.error('Failed to send monitoring alert:', e);
                        // Если бот заблокирован или чат не найден — останавливаем мониторинг
                        this.riskService.stopMonitoring();
                    }
                }
            };

            // Запускаем и передаем колбэк
            this.riskService.startMonitoring(sendNotification);

            // Сообщение о старте придет из самого сервиса (он сразу вызывает колбэк при старте),
            // поэтому тут можно ничего не писать или просто подтвердить нажатие.
        }
    }
}