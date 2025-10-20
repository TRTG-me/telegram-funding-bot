// src/modules/paradex/paradex.controller.ts

import { Context } from 'telegraf';
import { ParadexService } from './paradex.service';

type ReplyKeyboard = ReturnType<typeof import("telegraf").Markup.keyboard>;

export class ParadexController {
    constructor(
        private readonly paradexService: ParadexService,
        // userState пока не используется, но оставлен для будущих расширений
        private readonly userState: Map<number, string>
    ) { }

    public async onAccountRequest(ctx: Context, mainMenuKeyboard: ReplyKeyboard) {
        try {
            await ctx.reply('⏳ Выполняю запрос к Paradex, это может занять несколько секунд...');

            // 1. Вызываем новый метод сервиса, который делает всю работу
            const leverage = await this.paradexService.calculateLeverage();

            // 2. Форматируем полученное число для красивого вывода
            const formattedLeverage = leverage.toFixed(3);

            // 3. Собираем и отправляем сообщение пользователю
            const message = `✅ Ваше текущее плечо на Paradex: <b>${formattedLeverage}x</b>`;
            await ctx.replyWithHTML(message, mainMenuKeyboard);

        } catch (error) {
            // 4. В случае любой ошибки из сервиса, сообщаем об этом
            console.error('❌ Произошла ошибка в процессе запроса к Paradex:', error);

            // Извлекаем сообщение из объекта Error, если оно есть
            const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка.';

            await ctx.reply(
                `❌ Произошла ошибка при выполнении запроса.\n\n<i>Детали: ${errorMessage}</i>`,
                { ...mainMenuKeyboard, parse_mode: 'HTML' }
            );
        }
    }
}