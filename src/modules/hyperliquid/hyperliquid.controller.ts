import { Context, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { Update } from "telegraf/typings/core/types/typegram";
import { HyperliquidService } from "./hyperliquid.service"; // Импортируем сервис и наш главный тип

// Псевдоним типа для клавиатуры
type ReplyKeyboard = ReturnType<typeof Markup.keyboard>;

export class HyperliquidController {
    constructor(
        private hyperliquidService: HyperliquidService,
        private userState: Map<number, string>
    ) { }


    // Метод для запроса адреса у пользователя
    // public onCheckAccountRequest(ctx: Context, mainMenuKeyboard: ReplyKeyboard): void {
    //     const userId = ctx.from!.id;
    //     this.userState.set(userId, 'awaiting_wallet_address');
    //     ctx.reply('Пожалуйста, введите ваш ETH адрес (например, 0x...):', mainMenuKeyboard);
    // }

    // Метод, который срабатывает после ввода адреса
    public async onWalletAddressReceived(ctx: Context<Update.MessageUpdate>, mainMenuKeyboard: ReplyKeyboard): Promise<void> {
        if (!ctx.has(message("text"))) return;

        const userId = ctx.from.id;
        const walletAddress = ctx.message.text.trim();
        const userAddress = process.env.ACCOUNT_HYPERLIQUID_ETH;
        if (!userAddress) {
            console.error('Критическая ошибка: Переменная ACCOUNT_HYPERLIQUID_ETH не найдена в .env');
            await ctx.reply('❌ Ошибка конфигурации. Не удалось найти адрес кошелька.', mainMenuKeyboard);
            return;
        }

        // Валидация адреса
        if (!/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
            await ctx.reply('❌ Адрес не похож на валидный ETH-кошелек. Попробуйте еще раз.', mainMenuKeyboard);
            return;
        }

        this.userState.delete(userId);
        await ctx.reply('⏳ Получаю информацию, это может занять несколько секунд...');

        try {

            const summary = await this.hyperliquidService.getDetailedPositions()
            console.log(summary)
            // // 1. Вызываем сервис и получаем чистый ОБЪЕКТ С ДАННЫМИ
            // const summary: FullAccountSummary = await this.hyperliquidService.getAccountSummary(userAddress);

            // // 2. Строим сообщение на основе полученных данных
            // let message = `<b>📊 Ваш аккаунт Hyperliquid</b>\n\n`;
            // message += `💰 <b>Общая стоимость:</b> <code>$${summary.accountValue.toFixed(2)}</code>\n`;
            // message += `💼 <b>Margin Used:</b> <code>$${summary.marginUsed.toFixed(2)}</code>\n`;
            // message += `杠 <b>Плечо (общее):</b> <code>${summary.leverage.toFixed(5)}x</code>\n\n`;
            // message += `<b>Открытые позиции</b>\n`;

            // if (summary.openPositions.length === 0) {
            //     message += "<i>Открытых позиций нет.</i>";
            // } else {
            //     let table = '';
            //     // Создаем красивую моноширинную таблицу
            //     for (const pos of summary.openPositions) {
            //         const sideEmoji = pos.side === 'Long' ? '🟢' : '🔴';
            //         const coinText = `${sideEmoji} ${pos.coin}`;
            //         const notionalText = `$${pos.notionalValue.toFixed(2)}`;
            //         const fundingText = `${pos.fundingRate.toFixed(4)}%`;

            //         table += `${coinText.padEnd(12)} ${notionalText.padEnd(15)} ${fundingText}\n`;
            //     }
            //     message += `<pre>${table}</pre>`;
            // }

            // // 3. Отправляем готовое HTML-сообщение
            // await ctx.replyWithHTML(message, mainMenuKeyboard);

        } catch (error) {
            // 4. Ловим любую ошибку из сервиса и сообщаем пользователю в вежливой форме
            console.error('Ошибка в контроллере Hyperliquid при обработке адреса:', error);
            await ctx.reply('Не удалось получить информацию. Убедитесь, что адрес корректен и имеет активность на Hyperliquid, или попробуйте позже.', mainMenuKeyboard);
        }
    }
}