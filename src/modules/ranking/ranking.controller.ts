import { RankingService } from './ranking.service';
import { bot } from '../../core/bot';

export class RankingController {
    constructor(
        private readonly rankingService: RankingService,
        private readonly userState: Map<number, string>
    ) { }

    /**
     * Просто показывает текущие ранги в удобочитаемом формате.
     */
    public async onShowRanks(ctx: any): Promise<void> {
        const ranks = await this.rankingService.getConfig();
        let message = 'Текущие настройки рангов:\n\n`';
        message += ranks.map(r => `от ${r.min} до ${r.max} -> ${r.emoji}`).join('\n');
        message += '`';
        await ctx.replyWithMarkdown(message);
    }


    public async onUpdateRanksRequest(ctx: any): Promise<void> {
        // 1. Получаем текущую конфигурацию
        const currentRanks = await this.rankingService.getConfig();

        // 2. Формируем сообщение, которое показывает текущий конфиг в виде JSON
        const currentConfigMessage = 'Текущая конфигурация для копирования и редактирования:\n\n' +
            '```json\n' +
            JSON.stringify(currentRanks, null, 2) +
            '\n```';

        // 3. Отправляем это сообщение пользователю
        await ctx.replyWithMarkdownV2(currentConfigMessage);

        // 4. Просим прислать новую или отредактированную версию
        await ctx.reply(
            'Теперь отправьте мне новую (или отредактированную) конфигурацию в виде JSON-строки.'
        );

        // 5. Устанавливаем состояние ожидания
        this.userState.set(ctx.from.id, 'awaiting_ranks_json');
    }

    /**
     * Обрабатывает полученный JSON и обновляет конфигурацию.
     */
    public async onRanksJsonReceived(ctx: any): Promise<void> {
        try {
            const newRanks = JSON.parse(ctx.message.text);
            await this.rankingService.updateConfig(newRanks);
            await ctx.reply('✅ Конфигурация рангов успешно обновлена!');
        } catch (error: any) {
            await ctx.reply(`❌ Ошибка! Не удалось обновить конфигурацию.\nПричина: ${error.message}`);
        } finally {
            this.userState.delete(ctx.from.id);
        }
    }
}