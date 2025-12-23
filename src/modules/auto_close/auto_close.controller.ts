import { Context } from 'telegraf';
import { AutoCloseService } from './auto_close.service';

export class AutoCloseController {

    constructor(private readonly riskService: AutoCloseService) { }

    /**
     * Ручная разовая проверка (команда /check_risk или кнопка)
     */
    public async handleManualCheck(ctx: Context): Promise<void> {
        if (!ctx.from) return;
        const userId = ctx.from.id;

        await ctx.reply('🛡 <b>Запуск ручной проверки...</b>\n(Risk + ADL Check)', { parse_mode: 'HTML' });

        try {
            // Запускаем проверку через сервис (он сам разберется с сессией)
            const { riskLogs, adlLogs } = await this.riskService.runManualCheck(userId);

            // Объединяем логи
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
        if (!ctx.from || !ctx.chat) return;
        const userId = ctx.from.id;
        const chatId = ctx.chat.id;

        // 1. Проверяем статус для конкретного пользователя
        const isActive = this.riskService.isRunning(userId);

        if (isActive) {
            // === ЕСЛИ ВКЛЮЧЕНО -> ВЫКЛЮЧАЕМ ===
            this.riskService.stopSession(userId);
            await ctx.reply('🛑 <b>Мониторинг остановлен.</b>', { parse_mode: 'HTML' });

        } else {
            // === ЕСЛИ ВЫКЛЮЧЕНО -> ВКЛЮЧАЕМ ===

            // Эта функция будет вызываться сервисом раз в минуту
            // Она замыкает chatId, действительный на момент запуска
            const sendNotification = async (msg: string) => {
                try {
                    // Используем telegram.sendMessage напрямую по ID чата
                    await ctx.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' });
                } catch (e: any) {
                    console.error(`[User ${userId}] Failed to send monitoring alert:`, e);
                    // Если бот заблокирован или чат не найден - останавливаем этот мониторинг
                    // (но нужно быть аккуратным, чтобы временные ошибки сети не убивали процесс)
                    if (e.description?.includes('blocked') || e.description?.includes('not found')) {
                        this.riskService.stopSession(userId);
                    }
                }
            };

            // Запускаем сессию
            this.riskService.startSession(userId, sendNotification);
        }
    }
}