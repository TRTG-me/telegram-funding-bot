// src/modules/hyperliquid/hyperliquid.controller.ts

import { Context, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { Update } from "telegraf/typings/core/types/typegram";
import { HyperliquidService } from "./hyperliquid.service";

// --- РЕШЕНИЕ ПРОБЛЕМЫ ---
// Создаем псевдоним типа.
// Этот тип будет в точности таким, какой возвращает функция Markup.keyboard()
type ReplyKeyboard = ReturnType<typeof Markup.keyboard>;


export class HyperliquidController {
    constructor(
        private hyperliquidService: HyperliquidService,
        private userState: Map<number, string>
    ) { }

    public onCheckAccountRequest(ctx: Context, mainMenuKeyboard: ReplyKeyboard) {
        const userId = ctx.from!.id;
        this.userState.set(userId, 'awaiting_wallet_address');
        ctx.reply('Пожалуйста, введите ваш ETH адрес (например, 0x...):', mainMenuKeyboard);
    }

    // Используем наш новый, корректный тип для параметра
    public async onWalletAddressReceived(ctx: Context<Update.MessageUpdate>, mainMenuKeyboard: ReplyKeyboard) {
        if (!ctx.has(message("text"))) return;

        const userId = ctx.from.id;
        const walletAddress = ctx.message.text.trim();

        if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
            ctx.reply('❌ Адрес не похож на валидный ETH-кошелек. Попробуйте еще раз.', mainMenuKeyboard);
            return;
        }

        this.userState.delete(userId);

        await ctx.reply('⏳ Получаю информацию, это может занять несколько секунд...');

        // ИЗМЕНЕНИЕ: Вызываем новый метод, который делает всю работу
        const formattedMessage = await this.hyperliquidService.getFormattedAccountInfo(walletAddress);

        if (!formattedMessage) {
            // Если сервис вернул null, значит была критическая ошибка
            ctx.reply('Не удалось получить информацию. Попробуйте позже.', mainMenuKeyboard);
            return;
        }

        // Теперь нам не нужно форматировать сообщение здесь, оно уже готово
        ctx.replyWithHTML(formattedMessage, mainMenuKeyboard);
    }
}