// src/modules/lighter/lighter.controller.ts

import { Context } from 'telegraf';
import { LighterService } from './lighter.service';

type ReplyKeyboard = ReturnType<typeof import("telegraf").Markup.keyboard>;

export class LighterController {
    constructor(
        private readonly lighterService: LighterService,
        private readonly userState: Map<number, string>
    ) { }

    public async onAccountRequestL(ctx: Context, mainMenuKeyboard: ReplyKeyboard) {
        try {
            await ctx.reply('⏳ Выполняю запрос к Lighter, это может занять несколько секунд...');

            // 1. Вызываем единый метод сервиса, который делает всю работу
            const accInfo = await this.lighterService.calculateLeverage();
            const posInfo = await this.lighterService.getDetailedPositions()
            console.log(posInfo)
            // 2. Форматируем полученное число для красивого вывода
            const formattedLeverage = accInfo.leverage.toFixed(3);
            const formattedEquity = accInfo.accountEquity.toFixed(3);

            // 3. Собираем и отправляем сообщение пользователю
            let message = `🚀 Плечо: ${formattedLeverage}\n`;
            message += `💰 Account Equity: ${formattedEquity}`;

            await ctx.replyWithHTML(message, mainMenuKeyboard);

        } catch (error) {
            // 4. В случае любой ошибки из сервиса, сообщаем об этом
            console.error('❌ Произошла ошибка в процессе запроса к Lighter:', error);

            // Извлекаем сообщение из объекта Error
            const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка.';

            await ctx.reply(
                `❌ Произошла ошибка при выполнении запроса.\n\n<i>Детали: ${errorMessage}</i>`,
                { ...mainMenuKeyboard, parse_mode: 'HTML' }
            );
        }
    }
}