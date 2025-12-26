import { Context, Markup } from 'telegraf';
import { SettingsService } from './settings.service';

export class SettingsController {
    constructor(
        private readonly settingsService: SettingsService,
        private readonly userStates: Map<number, string>
    ) { }

    public async onSettingsCommand(ctx: Context): Promise<void> {
        const settings = this.settingsService.getSettings();
        const userId = ctx.from?.id;

        const message = '⚙️ <b>Текущие настройки</b>\n\n' +
            '<code>' + JSON.stringify(settings, null, 2) + '</code>\n\n' +
            'Чтобы изменить, отправьте новый JSON.\n' +
            'Кнопка ниже отменит режим редактирования.';

        await ctx.reply(message, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                Markup.button.callback('❌ Отмена / Закрыть', 'settings_cancel')
            ])
        });

        if (userId) {
            this.userStates.set(userId, 'awaiting_settings_json');
        }
    }

    public async handleCallback(ctx: any): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery.data;
        if (data === 'settings_cancel') {
            this.userStates.delete(userId);
            await ctx.answerCbQuery('Редактирование отменено');
            await ctx.editMessageText('✅ <b>Просмотр завершен.</b>\nНастройки не изменены.', { parse_mode: 'HTML' });
        }
    }

    public async onSettingsJsonReceived(ctx: any): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const newSettings = JSON.parse(ctx.message.text);

            // Базовая валидация структуры
            if (!newSettings.leverage || !newSettings.adl) {
                throw new Error('Некорректная структура JSON. Должны быть поля leverage и adl.');
            }

            await this.settingsService.updateSettings(newSettings);
            await ctx.reply('✅ Настройки успешно обновлены!');
        } catch (error: any) {
            await ctx.reply(`❌ Ошибка обновления настроек: ${error.message}`);
        } finally {
            this.userStates.delete(userId);
        }
    }
}
