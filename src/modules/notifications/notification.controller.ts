// src/modules/notifications/notification.controller.ts

import { Context } from 'telegraf';
import { NotificationService } from './notification.service';

export class NotificationController {
    constructor(private readonly notificationService: NotificationService) { }

    public async startMonitoring(ctx: Context) {
        try {
            // Проверяем, что пользователь определен
            if (!ctx.from) {
                await ctx.reply("Не удалось идентифицировать пользователя.");
                return;
            }
            const userId = ctx.from.id;
            const message = this.notificationService.startMonitoring(userId);
            await ctx.reply(message);
        } catch (error) {
            console.error("Ошибка при запуске мониторинга:", error);
            await ctx.reply("🔴 Не удалось запустить мониторинг.");
        }
    }

    public async stopMonitoring(ctx: Context) {
        try {
            // Проверяем, что пользователь определен
            if (!ctx.from) {
                await ctx.reply("Не удалось идентифицировать пользователя.");
                return;
            }
            const userId = ctx.from.id;
            const message = this.notificationService.stopMonitoring(userId);
            await ctx.reply(message);
        } catch (error) {
            console.error("Ошибка при остановке мониторинга:", error);
            await ctx.reply("🔴 Не удалось остановить мониторинг.");
        }
    }
}