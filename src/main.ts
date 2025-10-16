// src/main.ts
import { bot } from './core/bot';
import { CalculatorController } from './modules/calculator/calculator.controller';

async function start() {
    // --- Инициализация контроллеров ---
    const calculatorController = new CalculatorController();

    // --- Регистрация команд бота ---
    bot.start((ctx) => {
        ctx.reply('Привет! Я бот-калькулятор. Отправь мне команду /multiply с двумя числами, чтобы я их умножил.');
    });

    // Привязываем метод контроллера к команде /multiply
    bot.command('multiply', calculatorController.onMultiplyCommand);

    // --- Запуск бота ---
    await bot.launch();
    console.log('Бот успешно запущен!');
}

start();