import { Context } from 'telegraf';
import { BinanceService } from '../binance/binance.service';

// Хелпер для паузы (чтобы подождать исполнения ордера)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class BinTradeController {
    constructor(private readonly binanceService: BinanceService) { }

    /**
     * Обрабатывает команду на размещение лимитного ордера.
     */
    public async handlePlaceOrderCommand(ctx: Context): Promise<void> {
        // --- ПАРАМЕТРЫ ОРДЕРА ---
        const orderParams = {
            symbol: 'ETHUSDT',
            side: 'SELL' as 'BUY' | 'SELL',
            quantity: 0.015,  // Обратите внимание на минимальный лот
            price: 2500,     // Лимитная цена
        };

        try {
            // 1. Первичное сообщение
            await ctx.reply(`⏳ Отправляю лимитный ордер: ${orderParams.side} ${orderParams.quantity} ${orderParams.symbol} по цене ${orderParams.price}...`);

            const initialResult = await this.binanceService.placeBinOrder(
                orderParams.symbol,
                orderParams.side,
                orderParams.quantity,
                orderParams.price
            );

            // Получаем ID созданного ордера
            const clientOrderId = initialResult.clientOrderId;

            // 3. Сообщаем пользователю, что ордер создан (но статус пока может быть NEW)
            await ctx.replyWithHTML(
                `✅ <b>Ордер размещен!</b>\n` +
                `🆔 ID: ${clientOrderId}\n` +
                `⏳ Жду подтверждения исполнения...`
            );

            // 4. Ждем 2 секунды, чтобы Бинанс успел свести ордер (если цена позволяет)
            await sleep(500);

            // 5. Проверяем актуальный статус через queryUmOrder
            const finalOrder = await this.binanceService.getBinOrderInfo(orderParams.symbol, clientOrderId);

            // 6. Формируем финальный отчет в зависимости от статуса
            let finalMessage = '';

            if (finalOrder.status === 'FILLED') {
                // Если ордер исполнился полностью
                finalMessage = `🚀 <b>Ордер ИСПОЛНЕН!</b>\n\n` +
                    `🔹 <b>Пара:</b> ${finalOrder.symbol}\n` +
                    `🔹 <b>Сторона:</b> ${finalOrder.side}\n` +
                    `🔹 <b>Размер:</b> ${finalOrder.executedQty} (из ${finalOrder.origQty})\n` +
                    `💵 <b>Средняя цена входа:</b> ${parseFloat(finalOrder.avgPrice).toFixed(2)}\n` + // avgPrice - реальная цена
                    `💰 <b>Потрачено:</b> ${parseFloat(finalOrder.cumQuote).toFixed(2)} USDT`;
            } else if (finalOrder.status === 'PARTIALLY_FILLED') {
                // Если исполнился частично
                finalMessage = `⚠️ <b>Ордер ЧАСТИЧНО исполнен!</b>\n\n` +
                    `🔹 <b>Заполнено:</b> ${finalOrder.executedQty} / ${finalOrder.origQty}\n` +
                    `💵 <b>Текущая ср. цена:</b> ${parseFloat(finalOrder.avgPrice).toFixed(2)}`;
            } else {
                // Если все еще висит (NEW)
                finalMessage = `🕒 <b>Ордер открыт и ждет цены</b>\n\n` +
                    `🔹 <b>Статус:</b> ${finalOrder.status}\n` +
                    `🔹 <b>Лимитная цена:</b> ${parseFloat(finalOrder.price).toFixed(2)}\n` +
                    `🔹 <b>Заполнено:</b> ${finalOrder.executedQty}`;
            }

            await ctx.replyWithHTML(finalMessage);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка.';
            console.error('❌ Ошибка в контроллере:', error);
            await ctx.reply(`❌ Ошибка при работе с ордером.\n\n<i>${errorMessage}</i>`, { parse_mode: 'HTML' });
        }
    }
}