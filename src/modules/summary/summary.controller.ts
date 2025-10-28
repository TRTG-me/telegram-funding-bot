// src/modules/summary/summary.controller.ts

import { Context } from 'telegraf';
// ИЗМЕНЕНИЕ: Импортируем новый, правильный тип из сервиса.
import { SummaryService, FormattedExchangeData } from './summary.service';

export class SummaryController {
    constructor(private readonly summaryService: SummaryService) { }

    public async sendSummaryTable(ctx: Context) {
        try {
            await ctx.reply('Собираю и форматирую данные, пожалуйста, подождите...');

            // ИЗМЕНЕНИЕ: Вызываем новый метод сервиса.
            const data: FormattedExchangeData[] = await this.summaryService.getFormattedSummaryData();

            let messageRows = '';

            data.forEach(exchange => {
                const equity = Math.round(exchange.accountEquity);
                const leverage = `${exchange.emoji}${exchange.leverage.toFixed(2)}`;

                // --- ИЗМЕНЕНИЯ ЗДЕСЬ ---
                // Просто оборачиваем содержимое тега <code> в тег <b>
                messageRows += `<b>${exchange.name}</b>\n`;
                messageRows += `  Equity:   <b>${equity.toString().padStart(7)}$</b>\n`;
                messageRows += `  Leverage: <b>${leverage.padStart(7)}x</b>\n\n`;
            });

            const finalMessage = '<b>📊 Сводные данные по биржам:</b>\n\n' + messageRows;

            await ctx.replyWithHTML(finalMessage);

        } catch (error) {
            console.error('Ошибка при создании сводной таблицы:', error);
            await ctx.reply('Произошла ошибка при получении данных. Попробуйте позже.');
        }
    }
}