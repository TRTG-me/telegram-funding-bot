// src/main.ts

import { Markup } from 'telegraf';
import { bot } from './core/bot';

// Импортируем оба контроллера и сервиса
import { HyperliquidController } from './modules/hyperliquid/hyperliquid.controller';
import { HyperliquidService } from './modules/hyperliquid/hyperliquid.service';
import { CalculatorController } from './modules/calculator/calculator.controller';
import { CalculatorService } from './modules/calculator/calculator.service';
import { TestController } from './modules/TEST/test.controller';
import { TestService } from './modules/TEST/test.service';


import { message } from 'telegraf/filters';

const mainMenuKeyboard = Markup.keyboard([
    ['🔎 Проверить аккаунт', '✖️ Калькулятор', 'TEST']
]).resize();

const userState = new Map<number, string>();

async function start() {
    // --- Инициализация всех сервисов и контроллеров ---
    const hyperliquidService = new HyperliquidService();
    const hyperliquidController = new HyperliquidController(hyperliquidService, userState);

    const calculatorService = new CalculatorService();
    const calculatorController = new CalculatorController(calculatorService, userState);

    const testService = new TestService();
    const testController = new TestController(testService, userState);

    // --- Регистрация команды /start ---
    bot.start((ctx) => {
        // При старте на всякий случай сбрасываем состояние
        userState.delete(ctx.from.id);
        ctx.reply(
            'Привет! Используйте меню внизу.',
            mainMenuKeyboard
        );
    });

    // --- Общий обработчик-маршрутизатор для всех текстовых сообщений ---
    bot.on(message('text'), (ctx) => {
        const userId = ctx.from.id;
        const text = ctx.message.text;
        const currentState = userState.get(userId);

        // --- ИЗМЕНЕНИЕ ЛОГИКИ ---
        // Сначала проверяем, не является ли сообщение командой из главного меню.
        // Это позволяет "перебить" любое предыдущее состояние.
        if (text === '🔎 Проверить аккаунт' || text === '✖️ Калькулятор' || text === 'TEST') {
            userState.delete(userId); // Сбрасываем предыдущее состояние!

            switch (text) {
                case '🔎 Проверить аккаунт':
                    hyperliquidController.onCheckAccountRequest(ctx, mainMenuKeyboard);
                    return; // Выходим

                case '✖️ Калькулятор':
                    // ИСПРАВЛЕНИЕ: Теперь мы передаем клавиатуру
                    calculatorController.onMultiplyRequest(ctx, mainMenuKeyboard);
                    return; // Выходим

                case 'TEST':
                    // ИСПРАВЛЕНИЕ: Теперь мы передаем клавиатуру
                    testController.onTestSum(ctx, mainMenuKeyboard);
                    return; // Выходим
            }
        }

        // Если это не команда из меню, тогда проверяем состояние
        if (currentState === 'awaiting_wallet_address') {
            hyperliquidController.onWalletAddressReceived(ctx, mainMenuKeyboard);
            return;
        }
        if (currentState === 'awaiting_multiplication_numbers') {
            calculatorController.onNumbersReceived(ctx, mainMenuKeyboard);
            return;
        }
        if (currentState === 'awaiting_sum_numbers') {
            testController.onNumbersReceivedSum(ctx, mainMenuKeyboard);
            return;
        }

        // Если мы дошли до сюда, значит, это неизвестная команда
        ctx.reply('Неизвестная команда. Пожалуйста, используйте кнопки внизу.', mainMenuKeyboard);
    });

    // --- Запуск бота ---
    await bot.launch();
    console.log('Бот успешно запущен с исправленной логикой!');
}

start();