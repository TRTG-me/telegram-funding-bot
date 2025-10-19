// src/modules/binance/binance.controller.ts

import { Context } from 'telegraf';
import { BinanceService } from './binance.service';

// Определяем псевдоним типа для клавиатуры
type ReplyKeyboard = ReturnType<typeof import("telegraf").Markup.keyboard>;

/**
 * Вспомогательная функция для экранирования специальных символов для MarkdownV2.
 * Telegram требует, чтобы символы . ! - = { } ( ) > # + _ | [ ] ` ~ были экранированы обратным слэшем.
 */

// Определяем, как выглядит "валидный" объект для нашей логики
interface ValidAccountInfo {
    accountEquity: string;
    accountStatus: string;
    // ... другие обязательные поля
}

// Функция-предохранитель, которая проверяет структуру объекта
function isAccountInfoValid(data: any): data is ValidAccountInfo {
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

            const accountInfo = await this.binanceService.getAccountInfo();
            // const posInfo = await this.binanceService.getPositionInfo()
            const leverage = await this.binanceService.calculateAccountLeverage()
            // console.log('Получен ответ от API Binance:', accountInfo);
            // console.log('Pos Bin', posInfo)
            // // --- ИСПОЛЬЗУЕМ НАШУ ЕДИНУЮ ПРОВЕРКУ ---
            // if (isAccountInfoValid(accountInfo)) {
            if (isFinite(leverage) && isAccountInfoValid(accountInfo)) {
                //     // ВНУТРИ ЭТОГО БЛОКА TYPESCRIPT УМНЫЙ!
                //     // Он знает, что accountInfo имеет тип ValidAccountInfo,
                //     // а значит, все поля существуют и являются строками.
                console.log(accountInfo)
                //     // Никаких ошибок 'undefined' здесь больше не будет!
                //     const equity = parseFloat(accountInfo.accountEquity).toFixed(2);
                //     const status = accountInfo.accountStatus; // Тоже безопасно

                //     const escapedEquity = escapeMarkdownV2(equity);
                //     const escapedStatus = escapeMarkdownV2(status);
                const formattedLeverage = leverage.toFixed(3);

                const escapedLeverage = escapeMarkdownV2(formattedLeverage);
                console.log('Плечо Бин =', escapedLeverage)

                const message = `🚀 *Плечо:* \`${escapedLeverage}\``;

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