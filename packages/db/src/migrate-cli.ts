import { migrate } from './migrate';

const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('Defina DATABASE_OWNER_URL (papel dono do schema).');
  process.exit(1);
}
migrate(url, console.log)
  .then((v) => console.log(v.length ? `${v.length} migração(ões) aplicada(s).` : 'Banco já atualizado.'))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
