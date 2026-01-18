import { Injectable } from '@nestjs/common';
import { Context, Markup } from 'telegraf';
import {
    TotalPositionsService,
    HedgedPair,
    UnhedgedPosition,
    AggregatedPositions
} from './totalPositions.service';

import { PayBackService } from '../payback/payback.service';
import { LighterService } from '../lighter/lighter.service';
import { FundingApiService } from '../funding_api/funding_api.service';
import { PayBackSession } from '../payback/payback.session';
import { ExchangeName } from '../bp/bp.types';

const EXCHANGE_MAP: Record<string, ExchangeName> = {
    'B': 'Binance',
    'H': 'Hyperliquid',
    'P': 'Paradex',
    'L': 'Lighter',
    'E': 'Extended'
};

@Injectable()
export class TotalPositionsController {
    constructor(
        private readonly totalPositionsService: TotalPositionsService,
        private readonly paybackService: PayBackService,
        private readonly lighterService: LighterService,
        private readonly fundingApiService: FundingApiService
    ) { }

    public async handleCallbackQuery(ctx: Context): Promise<void> {
        const data = (ctx.callbackQuery as any).data;
        if (data === 'tp_check_bp_close') {
            await this.handleBpCloseCheck(ctx);
        }
    }

    public async displayAggregatedPositions(ctx: Context): Promise<void> {
        try {
            await ctx.reply('🤖 Начинаю сверку позиций... Пожалуйста, подождите.');
            const userId = ctx.from?.id;
            const data = await this.totalPositionsService.getAggregatedPositions(userId);
            const message = this._renderPositionsTable(data);
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔍 Проверка bp закрытие', 'tp_check_bp_close')]
            ]);
            await ctx.replyWithHTML(message, keyboard);
        } catch (error) {
            console.error('Критическая ошибка в TotalPositionsController:', error);
            await ctx.reply('🔴 Произошла ошибка при сверке позиций. Подробности в логах сервера.');
        }
    }

    public async handleBpCloseCheck(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            if (this.paybackService.isSessionActive(userId)) {
                ctx.reply('⚠️ Уже запущен расчет (окупаемости или BP). Дождитесь завершения (60 сек).');
                return;
            }

            const waitMsg = await ctx.reply('⏳ Запускаю проверку BP для закрытия хедж-пар...\nЭто займет 60 секунд. Пожалуйста, подождите.');
            const data = await this.totalPositionsService.getAggregatedPositions(userId);

            if (data.hedgedPairs.length === 0) {
                await ctx.deleteMessage(waitMsg.message_id).catch(() => { });
                ctx.reply('📭 Хеджированные пары для проверки не найдены.');
                return;
            }

            const results: Record<string, number> = {};
            const sessions: PayBackSession[] = [];

            const promises = data.hedgedPairs.map(async (pair) => {
                const parts = pair.exchanges.split('-'); // e.g. "P-H"
                const longKey = parts[0]; // "P"
                const shortKey = parts[1]; // "H"

                const currentLongEx = EXCHANGE_MAP[longKey];
                const currentShortEx = EXCHANGE_MAP[shortKey];

                if (!currentLongEx || !currentShortEx) return;

                // Для закрытия ОСНОВНОЙ ПАРЫ (Long P, Short H):
                // Нам нужно: Продать P (hitting Bid), Купить H (hitting Ask)
                // То есть: Long H (Buy), Short P (Sell)
                const session = new PayBackSession(userId, this.lighterService, this.fundingApiService);
                sessions.push(session);

                return new Promise<void>((resolve) => {
                    session.start(pair.coin, currentShortEx, currentLongEx, (res) => {
                        if (res) {
                            results[`${pair.coin}_${pair.exchanges}`] = res.averageBp;
                        }
                        resolve();
                    }).catch(() => resolve());
                });
            });

            await Promise.all(promises);
            await ctx.deleteMessage(waitMsg.message_id).catch(() => { });

            const message = this._renderPositionsTable(data, results);
            await ctx.replyWithHTML(message);

        } catch (error: any) {
            console.error('Ошибка при проверке BP закрытия:', error);
            await ctx.reply(`❌ Ошибка проверки BP: ${error.message}`);
        }
    }

    private _renderPositionsTable(data: AggregatedPositions, bpResults?: Record<string, number>): string {
        const { hedgedPairs, unhedgedPositions } = data;
        let message = '<pre><code>';

        message += 'Хеджированные пары\n';
        // Расширяем разделитель, если есть БП (примерно +10 символов)
        const headerLine = `----------------------------------------------------------${bpResults ? '----------' : ''}\n`;
        message += headerLine;

        if (hedgedPairs.length > 0) {
            hedgedPairs.forEach(pair => {
                const coin = pair.coin.padEnd(8);
                const size = pair.size.toString().padEnd(8);
                const notional = (pair.notional.toString() + '$').padEnd(12);
                const exchanges = pair.exchanges.padEnd(6);
                const price = Number(pair.price.toPrecision(3)).toString().padEnd(10);
                const funding1 = (pair.funding1.toString() + '%').padEnd(10);
                const funding2 = (pair.funding2.toString() + '%').padEnd(10);
                const fundingDiff = (pair.fundingDiff.toString() + '%').padEnd(8);

                let row = `${coin}${notional}${size}${exchanges}${price}${funding1}${funding2}${fundingDiff}`;

                if (bpResults) {
                    const bp = bpResults[`${pair.coin}_${pair.exchanges}`];
                    const bpStr = bp !== undefined ? bp.toFixed(1).padStart(6) : '  --- '.padStart(6);
                    row += `${bpStr}`;
                }

                message += row + '\n';
            });
        } else {
            message += 'Хеджированных пар не найдено.\n';
        }

        message += '\n';

        message += 'Нехеджированные позиции\n';
        message += headerLine;

        if (unhedgedPositions.length > 0) {
            unhedgedPositions.forEach(pos => {
                const coin = pos.coin.padEnd(8);
                const notional = (pos.notional.toString() + '$').padEnd(12);
                const size = pos.size.toString().padEnd(8);
                const price = Number(pos.price.toPrecision(3)).toString().padEnd(10);
                const side = pos.side.padEnd(7);
                const exchange = pos.exchange.padEnd(4);
                const fundingRate = pos.fundingRate.toString() + '%';

                message += `${coin}${notional}${size}${price}${side}${exchange}${fundingRate}\n`;
            });
        } else {
            message += 'Все позиции полностью хеджированы.\n';
        }

        message += '</code></pre>';
        return message;
    }
}
