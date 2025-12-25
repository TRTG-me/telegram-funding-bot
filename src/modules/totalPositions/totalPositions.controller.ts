import { Injectable } from '@nestjs/common';
import { Context } from 'telegraf';
import {
    TotalPositionsService,
    HedgedPair,
    UnhedgedPosition,
    AggregatedPositions
} from './totalPositions.service';

@Injectable()
export class TotalPositionsController {
    constructor(private readonly totalPositionsService: TotalPositionsService) { }

    /**
     * Основной метод контроллера.
     * Получает агрегированные данные, форматирует их в текстовую таблицу и отправляет в Telegram.
     * @param ctx - Контекст Telegraf для отправки сообщений пользователю.
     */
    public async displayAggregatedPositions(ctx: Context): Promise<void> {
        try {
            await ctx.reply('🤖 Начинаю сверку позиций... Пожалуйста, подождите.');

            const userId = ctx.from?.id;
            const { hedgedPairs, unhedgedPositions }: AggregatedPositions =
                await this.totalPositionsService.getAggregatedPositions(userId);


            let message = '<pre><code>';


            message += 'Hedged Pairs\n';
            message += '----------------------------------------------------------\n';

            if (hedgedPairs.length > 0) {
                hedgedPairs.forEach(pair => {
                    const coin = pair.coin.padEnd(8);
                    const size = pair.size.toString().padEnd(8);
                    const notional = (pair.notional.toString() + '$').padEnd(12);
                    const exchanges = pair.exchanges.padEnd(6);
                    const funding1 = (pair.funding1.toString() + '%').padEnd(10);
                    const funding2 = (pair.funding2.toString() + '%').padEnd(10);
                    const fundingDiff = pair.fundingDiff.toString() + '%';

                    message += `${coin}${notional}${size}${exchanges}${funding1}${funding2}${fundingDiff}\n`;
                });
            } else {
                message += 'Хеджированные пары не найдены.\n';
            }

            message += '\n';


            message += 'Unhedged Positions\n';
            message += '----------------------------------------------------------\n';

            if (unhedgedPositions.length > 0) {
                unhedgedPositions.forEach(pos => {
                    const coin = pos.coin.padEnd(8);

                    const notional = (pos.notional.toString() + '$').padEnd(12);
                    const size = pos.size.toString().padEnd(8);
                    const side = pos.side.padEnd(7);
                    const exchange = pos.exchange.padEnd(4);
                    const fundingRate = pos.fundingRate.toString() + '%';

                    message += `${coin}${notional}${size}${side}${exchange}${fundingRate}\n`;
                });
            } else {
                message += 'Все позиции полностью хеджированы.\n';
            }


            message += '</code></pre>';

            await ctx.replyWithHTML(message);

        } catch (error) {
            console.error('Критическая ошибка в TotalPositionsController:', error);
            await ctx.reply('🔴 Произошла ошибка при сверке позиций. Подробности в логах сервера.');
        }
    }
}
