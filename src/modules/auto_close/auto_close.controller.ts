import { Context } from 'telegraf';
import { AutoCloseService } from './auto_close.service';

export class AutoCloseController {
    constructor(private readonly riskService: AutoCloseService) { }

    public async handleManualCheck(ctx: Context): Promise<void> {
        // Проверка прав (опционально)
        // const userId = ctx.from?.id;

        await ctx.reply('🛡 <b>Запуск проверки рисков...</b>\nСбор данных и расчет плечей...', { parse_mode: 'HTML' });

        try {
            const logs = await this.riskService.checkAndReduceRisk();

            if (logs.length === 0) {
                await ctx.reply('✅ Проверка завершена. Действий не требуется.', { parse_mode: 'HTML' });
                return;
            }

            // Формируем отчет
            const message = logs.join('\n');

            // Если сообщение слишком длинное, Телеграм может отклонить, поэтому можно разбить
            // Но для теста пока так
            await ctx.reply(`<b>ОТЧЕТ АВТО-ЗАКРЫТИЯ:</b>\n\n${message}`, { parse_mode: 'HTML' });

        } catch (error: any) {
            console.error('Risk Check Error:', error);
            await ctx.reply(`❌ <b>Ошибка проверки рисков:</b>\n${error.message}`, { parse_mode: 'HTML' });
        }
    }
}