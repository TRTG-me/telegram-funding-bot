import { Context } from 'telegraf';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';

export class HypeTradeController {
    constructor(private readonly hypeService: HyperliquidService) { }

    public async handlePlaceOrderCommand(ctx: Context): Promise<void> {
        // --- ПАРАМЕТРЫ ---
        const orderParams = {
            symbol: 'ETH-PERP',
            side: 'BUY' as 'BUY' | 'SELL',
            quantity: 0.03,
        };

        try {
            await ctx.reply(`🌊 [Hyperliquid] Отправляю MARKET ордер: ${orderParams.side} ${orderParams.quantity} ${orderParams.symbol}...`);

            // 1. Вызываем сервис (он теперь вернет avgPrice и executedQty)
            const result = await this.hypeService.placeMarketOrder(
                orderParams.symbol,
                orderParams.side,
                orderParams.quantity,
            );

            // 2. Генерируем время (локально, т.к. в ответе маркета таймстемпа нет, но исполнение мгновенное)
            const now = new Date();
            const timeString = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

            // 3. Считаем сумму сделки
            const totalCost = result.avgPrice * result.executedQty;

            // 4. Формируем сообщение
            const successMessage = `🚀 <b>Hyperliquid Ордер Исполнен!</b>\n\n` +
                `🕒 <b>Время:</b> ${timeString}\n` +
                `🔹 <b>Монета:</b> ${result.symbol}\n` +
                `🔹 <b>Тип:</b> MARKET ${result.side}\n` +
                `📉 <b>Размер:</b> ${result.executedQty}\n` +
                `💵 <b>Цена входа:</b> ${result.avgPrice.toFixed(2)}\n` +
                `💰 <b>Сумма:</b> ${totalCost.toFixed(2)} USD\n` +
                `🆔 <b>OID:</b> ${result.orderId}`;

            await ctx.replyWithHTML(successMessage);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка';
            console.error('❌ HypeController Error:', error);
            await ctx.reply(`❌ Ошибка Hyperliquid.\n\n<i>${errorMessage}</i>`, { parse_mode: 'HTML' });
        }
    }
}