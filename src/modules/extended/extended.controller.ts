import { Context } from 'telegraf';
import { ExtendedService } from './extended.service';

type ReplyKeyboard = ReturnType<typeof import("telegraf").Markup.keyboard>;

export class ExtendedController {
    constructor(
        private readonly extendedService: ExtendedService,
        private readonly userState: Map<number, string>
    ) { }

    public async onPositionsRequest(ctx: Context, mainMenuKeyboard: ReplyKeyboard) {
        try {
            await ctx.reply('⏳ Запрашиваю данные с Extended Exchange...');

            // Вызываем сервис для получения данных
            const positionsData = await this.extendedService.getOpenPositions();

            // Выводим полученные данные в лог сервера, как вы и просили
            console.log('✅ Успешно получены данные с Extended Exchange:', positionsData);

            // Отправляем пользователю сообщение об успехе
            await ctx.reply('✅ Запрос успешно выполнен!', mainMenuKeyboard);

        } catch (error) {
            // В случае ошибки в сервисе, логируем ее и сообщаем пользователю
            console.error('❌ Произошла ошибка в процессе запроса к Extended Exchange:', error);
            await ctx.reply(
                '❌ Произошла ошибка при выполнении запроса. Подробности в логе сервера.',
                mainMenuKeyboard
            );
        }
    }
}