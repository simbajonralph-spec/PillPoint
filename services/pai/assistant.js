const { handleCustomerMessage } = require('./customer');

async function handleAssistantMessage(message, options) {
  return handleCustomerMessage(message, options);
}

module.exports = {
  handleAssistantMessage,
};
