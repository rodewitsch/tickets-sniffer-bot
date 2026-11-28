// Минимальная контрольная функция — ровно как в официальном образце
// digitalocean/sample-functions-nodejs-helloworld. Нужна для проверки
// ГИПОТЕЗЫ: ошибка «Cannot read properties of undefined (reading 'js')» в этом
// namespace относится к моему коду или к самому рантайму nodejs:22?
// Если этот файл тоже падает — дело в рантайме, и его надо менять (nodejs:20
// или nodejs:24), а не ковырять парсер.

function main(args) {
  const name = (args && args.name) || 'stranger';
  return { body: `Hello ${name}!` };
}

exports.main = main;
