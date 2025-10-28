// src/modules/binance/binance.controller.ts

import { Context } from 'telegraf';
import { BinanceService } from './binance.service';
import { IValidAccountInfoBin } from '../../common/interfaces'
// Определяем псевдоним типа для клавиатуры
type ReplyKeyboard = ReturnType<typeof import("telegraf").Markup.keyboard>;

// Функция-предохранитель, которая проверяет структуру объекта
function isAccountInfoValid(data: any): data is IValidAccountInfoBin {
    return (
        data &&
        typeof data.accountEquity === 'string' &&
        typeof data.accountStatus === 'string'
    );
}
function escapeMarkdownV2(text: string): string {
    const specialChars = /[_*[\]()~`>#+\-=|{}.!]/g;
    return text.replace(specialChars, '\\$&');
}

export class BinanceController {
    constructor(
        private readonly binanceService: BinanceService,
        private readonly userState: Map<number, string>
    ) { }

    public async onEquityRequest(ctx: Context, mainMenuKeyboard: ReplyKeyboard) {
        try {
            await ctx.reply('⏳ Запрашиваю данные вашего Portfolio Margin аккаунта...');

            const a = await this.binanceService.getDetailedPositions()
            const accountInfo = await this.binanceService.getAccountInfo();

            const info = await this.binanceService.calculateAccountLeverage()

            if (isFinite(info.leverage) && isAccountInfoValid(accountInfo)) {

                console.log(accountInfo)

                const formattedLeverage = info.leverage.toFixed(3);
                const formattedEquity = info.accountEquity.toFixed(1);
                const escapedEquity = escapeMarkdownV2(formattedEquity);
                const escapedLeverage = escapeMarkdownV2(formattedLeverage);


                let message = `🚀 *Плечо:* ${escapedLeverage}\n`;
                message += `💰 *Account Equity:* ${escapedEquity}`;
                await ctx.reply(message, {
                    parse_mode: 'MarkdownV2',
                    ...mainMenuKeyboard
                });

            } else {
                // Если проверка не пройдена, значит ответ от API некорректный
                await ctx.reply(
                    '❌ Получен некорректный или неполный ответ от API. Попробуйте позже.',
                    mainMenuKeyboard
                );
            }

        } catch (error) {
            // ... обработка ошибки запроса ...
        }
    }
}