import { Injectable } from '@nestjs/common';
import { Context } from 'telegraf';
import {
    TotalFundingsService,
} from './totalFundings.service';

import { IUnhedgedFundingResultRow, IFundingResultRow, IHistoricalFundingData } from '../../common/interfaces';

@Injectable()
export class TotalFundingsController {
    constructor(private readonly totalFundingsService: TotalFundingsService) { }

    /**
     * Форматирует массив данных по хеджированным парам в текстовую таблицу.
     */
    private _formatHedgedTable(results: IFundingResultRow[]): string {
        const headers = [
            'Coin'.padEnd(8),
            'Notional'.padEnd(12),
            'Exchanges'.padEnd(8),
            '1D'.padEnd(8),
            '3D'.padEnd(8),
            '7D'.padEnd(8),
            '14D'.padEnd(8),
        ];
        let table = headers.join('') + '\n';
        table += '-'.repeat(headers.join('').length) + '\n';

        if (results.length > 0) {
            results.forEach(row => {
                const coin = row.coin.padEnd(8);
                const notional = (row.notional.toString() + '$').padEnd(12);
                const exchanges = row.exchanges.padEnd(8);
                const fd1 = (row.funding_1d.toFixed(2) + '%').padEnd(8);
                const fd3 = (row.funding_3d.toFixed(2) + '%').padEnd(8);
                const fd7 = (row.funding_7d.toFixed(2) + '%').padEnd(8);
                const fd14 = (row.funding_14d.toFixed(2) + '%').padEnd(8);
                table += `${coin}${notional}${exchanges}${fd1}${fd3}${fd7}${fd14}\n`;
            });
        } else {
            table += 'Хеджированные пары не найдены.\n';
        }
        return table;
    }

    /**
     * Форматирует массив данных по нехеджированным позициям в текстовую таблицу.
     */
    private _formatUnhedgedTable(results: IUnhedgedFundingResultRow[]): string {
        const headers = [
            'Coin'.padEnd(8),
            'Notional'.padEnd(12),
            'Exch'.padEnd(6),
            'Side'.padEnd(6),
            '1D'.padEnd(8),
            '3D'.padEnd(8),
            '7D'.padEnd(8),
            '14D'.padEnd(8),
        ];
        let table = headers.join('') + '\n';
        table += '-'.repeat(headers.join('').length) + '\n';

        if (results.length > 0) {
            results.forEach(row => {
                const coin = row.coin.padEnd(8);
                const notional = (row.notional.toString() + '$').padEnd(12);
                const exchange = row.exchange.padEnd(6);
                const side = row.side.padEnd(6);
                const fd1 = (row.funding_1d.toFixed(2) + '%').padEnd(8);
                const fd3 = (row.funding_3d.toFixed(2) + '%').padEnd(8);
                const fd7 = (row.funding_7d.toFixed(2) + '%').padEnd(8);
                const fd14 = (row.funding_14d.toFixed(2) + '%').padEnd(8);
                table += `${coin}${notional}${exchange}${side}${fd1}${fd3}${fd7}${fd14}\n`;
            });
        } else {
            table += 'Нет нехеджированных позиций для анализа.\n';
        }
        return table;
    }

    public async displayHistoricalFunding(ctx: Context): Promise<void> {
        try {
            await ctx.reply('📈 Собираю исторические данные по фандингу... Это может занять до 20-30 секунд.');

            // Получаем объект с двумя массивами от сервиса
            const { hedged, unhedged }: IHistoricalFundingData =
                await this.totalFundingsService.getHistoricalFunding();

            let message = '';

            // Формируем первую таблицу
            message += '<pre><code>Hedged Pairs - Historical Funding\n';
            message += this._formatHedgedTable(hedged);
            message += '</code></pre>\n\n';

            // Формируем вторую таблицу
            message += '<pre><code>Unhedged Positions - Historical Funding\n';
            message += this._formatUnhedgedTable(unhedged);
            message += '</code></pre>';

            // Отправляем одно большое сообщение с двумя таблицами
            await ctx.replyWithHTML(message);

        } catch (error) {
            console.error('Критическая ошибка в TotalFundingsController:', error);
            await ctx.reply('🔴 Произошла ошибка при получении данных о фандинге.');
        }
    }
}