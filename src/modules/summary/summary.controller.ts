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

            const col1Width = 12;
            const col2Width = 14;
            const header = 'Биржа'.padEnd(col1Width) + ' | ' + 'Equity'.padStart(col2Width) + ' | ' + 'Leverage\n';
            const divider = '-'.repeat(col1Width) + '-+-' + '-'.repeat(col2Width) + '-+----------\n';

            let tableRows = '';

            // --- ГЛАВНОЕ УПРОЩЕНИЕ ЗДЕСЬ ---
            data.forEach(exchange => {
                const name = exchange.name.padEnd(col1Width);
                const equity = Math.round(exchange.accountEquity).toString().padStart(col2Width);

                // ИЗМЕНЕНИЕ: Эмодзи уже есть в объекте! Больше никаких вызовов сервиса.
                const leverage = `${exchange.emoji}${exchange.leverage.toFixed(1)}`;

                tableRows += `${name} | ${equity} | ${leverage}\n`;
            });

            const finalMessage = '<b>Сводные данные по биржам:</b>\n\n' +
                '<pre>' + header + divider + tableRows + '</pre>';

            await ctx.replyWithHTML(finalMessage);

        } catch (error) {
            console.error('Ошибка при создании сводной таблицы:', error);
            await ctx.reply('Произошла ошибка при получении данных. Попробуйте позже.');
        }
    }
}