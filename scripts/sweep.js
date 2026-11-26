require("dotenv").config({ quiet: true });
const { sweep } = require("../src/services/requestService");
if (require.main === module)
  sweep()
    .then(console.log)
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
exports.handler = async () => {
  const result = await sweep();
  console.log(JSON.stringify({ event: "maintenance", ...result }));
  return result;
};
