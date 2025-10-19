// src/notification.controller.ts

import { Context } from 'telegraf';
// Убираем лишние импорты Telegraf и Update, они здесь больше не нужны
import { NotificationService } from './notification.service';

export class NotificationController {
    // --- ИЗМЕНЕНИЕ №1 ---
    // Убираем `bot` из конструктора. Контроллеру он больше не нужен.
    // Теперь конструктор принимает ТОЛЬКО сервис.
    constructor(private notificationService: NotificationService) {
        // --- ИЗМЕНЕНИЕ №2 ---
        // Полностью удаляем регистрацию команд. Этим теперь занимается main.ts.
    }

    /**
     * Обработчик команды /start_monitoring
     */
    public async startMonitoring(ctx: Context) {
        if (!ctx.chat) {
            console.error('Не удалось получить ID чата, так как ctx.chat не определен.');
            return;
        }

        const chatId = ctx.chat.id;
        const isStarted = this.notificationService.startMarginMonitoring(chatId);

        if (isStarted) {
            // --- ИЗМЕНЕНИЕ №3 (опционально, но логично) ---
            // Убираем упоминание команд, так как теперь все управляется кнопками.
            await ctx.reply('✅ Мониторинг маржи запущен.\nПроверка будет выполняться каждые 15 секунд.\n\nЕсли маржа упадет ниже порога, я начну присылать настойчивые уведомления.');
        } else {
            await ctx.reply('ℹ️ Мониторинг уже был запущен ранее.');
        }
    }

    /**
     * Обработчик команды /stop_monitoring
     */
    public async stopMonitoring(ctx: Context) {
        if (!ctx.chat) {
            console.error('Не удалось получить ID чата, так как ctx.chat не определен.');
            return;
        }

        const chatId = ctx.chat.id;
        const isStopped = this.notificationService.stopMarginMonitoring(chatId);

        if (isStopped) {
            await ctx.reply('⏹️ Мониторинг маржи остановлен.');
        } else {
            await ctx.reply('ℹ️ Мониторинг не был запущен.');
        }
    }
}