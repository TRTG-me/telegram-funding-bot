import { Context } from 'telegraf';
import { ParadexService } from './paradex.service';

type ReplyKeyboard = ReturnType<typeof import("telegraf").Markup.keyboard>;

export class ParadexController {
    constructor(
        private readonly paradexService: ParadexService,
        private readonly userState: Map<number, string>
    ) { }

    public async onAccountRequest(ctx: Context, mainMenuKeyboard: ReplyKeyboard) {
        try {
            await ctx.reply('⏳ Выполняю запрос к Paradex...');

            // Вызываем главный метод сервиса
            const accountData = await this.paradexService.getAccountData();

            // Логируем полученные данные в консоль, как вы и просили
            console.log('✅ Успешно получены данные аккаунта Paradex:', accountData);

            // Отправляем пользователю сообщение об успехе
            await ctx.reply('✅ Запрос успешно выполнен! Данные выведены в лог сервера.', mainMenuKeyboard);

        } catch (error) {
            // В случае любой ошибки на этапах (подпись, JWT, запрос данных)
            console.error('❌ Произошла ошибка в процессе запроса к Paradex:', error);
            await ctx.reply(
                '❌ Произошла ошибка при выполнении запроса. Подробности в логе сервера.',
                mainMenuKeyboard
            );
        }
    }
}