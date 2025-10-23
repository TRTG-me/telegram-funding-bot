// src/modules/extended/extended.controller.ts

import { Context } from 'telegraf';
import { ExtendedService } from './extended.service';

type ReplyKeyboard = ReturnType<typeof import("telegraf").Markup.keyboard>;

export class ExtendedController {
    constructor(
        private readonly extendedService: ExtendedService,
        // Добавляем userState для единообразия с другими контроллерами
        private readonly userState: Map<number, string>
    ) { }

    public async onAccountRequest(ctx: Context, mainMenuKeyboard: ReplyKeyboard) {
        try {
            await ctx.reply('⏳ Выполняю запрос к Extended Exchange...');

            // 1. Вызываем единый метод сервиса, который делает всю работу
            const accInfo = await this.extendedService.calculateLeverage();

            // 2. Форматируем полученное число для красивого вывода
            const formattedLeverage = accInfo.leverage.toFixed(2);
            const formattedEquity = accInfo.accountEquity.toFixed(2);

            // 3. Собираем и отправляем сообщение пользователю
            let message = `🚀 Плечо: ${formattedLeverage}\n`;
            message += `💰 Account Equity: ${formattedEquity}`;
            await ctx.replyWithHTML(message, mainMenuKeyboard);

        } catch (error) {
            // 4. В случае любой ошибки из сервиса, сообщаем об этом
            console.error('❌ Произошла ошибка в процессе запроса к Extended Exchange:', error);

            // Извлекаем сообщение из объекта Error
            const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка.';

            await ctx.reply(
                `❌ Произошла ошибка при выполнении запроса.\n\n<i>Детали: ${errorMessage}</i>`,
                { ...mainMenuKeyboard, parse_mode: 'HTML' }
            );
        }
    }
}