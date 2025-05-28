import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  type Content,
  logger,
  ModelType,
  composePromptFromState,
} from '@elizaos/core';
import { z } from 'zod';
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  parseEther,
  parseUnits,
  formatEther,
  Interface,
} from 'ethers';
import { interactSmartContractTemplate } from '../templates';
import { callLLMWithTimeout } from '../utils/llmHelpers';

export const interactSmartContractAction: Action = {
  name: 'INTERACT_SMART_CONTRACT',
  similes: [
    'CALL_CONTRACT',
    'INVOKE_CONTRACT',
    'EXECUTE_CONTRACT_METHOD',
    'CONTRACT_INTERACTION',
    'SEND_CONTRACT_TRANSACTION',
  ],
  description:
    'Interacts with a smart contract by calling a state-changing method on Polygon zkEVM.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY') || process.env.ALCHEMY_API_KEY;
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL') || process.env.ZKEVM_RPC_URL;

    if (!alchemyApiKey && !zkevmRpcUrl) {
      logger.error('[interactSmartContractAction] ALCHEMY_API_KEY or ZKEVM_RPC_URL is required');
      return false;
    }

    // Check if the message content indicates a smart contract interaction request
    const content = message.content?.text?.toLowerCase() || '';

    // Keywords that indicate smart contract interaction
    const contractKeywords = [
      'call',
      'invoke',
      'execute',
      'interact',
      'contract',
      'method',
      'function',
      'abi',
      'transfer',
      'mint',
      'approve',
      'swap',
      'deposit',
      'withdraw',
      'burn',
      'send transaction',
      'call method',
      'execute method',
      'contract interaction',
      'smart contract',
      'call function',
      'invoke function',
      'execute function',
    ];

    // Check for contract address pattern (0x followed by 40 hex characters)
    const contractAddressPattern = /0x[a-fA-F0-9]{40}/;
    const hasContractAddress = contractAddressPattern.test(content);

    // Check for ABI pattern
    const hasABI = content.includes('abi') && (content.includes('[') || content.includes('{'));

    // Check for method/function names
    const hasMethodCall = contractKeywords.some((keyword) => content.includes(keyword));

    // Must have at least a contract address and method call, or explicit contract interaction keywords
    return (
      (hasContractAddress && hasMethodCall) ||
      hasABI ||
      content.includes('call the') ||
      content.includes('execute the') ||
      content.includes('invoke the') ||
      content.includes('interact with contract')
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[interactSmartContractAction] Handler called!');

    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY') || process.env.ALCHEMY_API_KEY;
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL') || process.env.ZKEVM_RPC_URL;
    const privateKey = runtime.getSetting('PRIVATE_KEY') || process.env.PRIVATE_KEY;

    if (!privateKey) {
      const errorMessage = 'PRIVATE_KEY is required for contract interaction.';
      logger.error(`[interactSmartContractAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['INTERACT_SMART_CONTRACT'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    if (!alchemyApiKey && !zkevmRpcUrl) {
      const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
      logger.error(`[interactSmartContractAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['INTERACT_SMART_CONTRACT'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let interactionParams: any | null = null;
    let transactionHash: string | null = null;
    let methodUsed: 'alchemy' | 'rpc' | null = null;
    let errorMessages: string[] = [];

    // Extract interaction parameters using LLM
    try {
      interactionParams = await callLLMWithTimeout<{
        contractAddress: string;
        abi: any[];
        methodName: string;
        args?: any[];
        gasLimit?: string | number;
        gasPrice?: string;
        maxFeePerGas?: string;
        maxPriorityFeePerGas?: string;
        value?: string;
        error?: string;
      }>(runtime, state, interactSmartContractTemplate, 'interactSmartContractAction');

      // Check if the model returned an error field
      if (interactionParams?.error) {
        logger.error(
          '[interactSmartContractAction] LLM returned an error:',
          interactionParams?.error
        );
        throw new Error(interactionParams?.error);
      }

      // Validate required parameters
      if (
        !interactionParams?.contractAddress ||
        typeof interactionParams.contractAddress !== 'string' ||
        !interactionParams.contractAddress.startsWith('0x')
      ) {
        throw new Error('Invalid contract address received from LLM. Address must start with 0x.');
      }

      if (!interactionParams?.abi || !Array.isArray(interactionParams.abi)) {
        throw new Error('Invalid ABI received from LLM. ABI must be a JSON array.');
      }

      if (!interactionParams?.methodName || typeof interactionParams.methodName !== 'string') {
        throw new Error('Invalid method name received from LLM. Method name must be a string.');
      }

      // Set default args if not provided
      if (!interactionParams.args) {
        interactionParams.args = [];
      }
    } catch (error) {
      logger.debug(
        '[interactSmartContractAction] LLM extraction failed',
        error instanceof Error ? error : undefined
      );
      throw new Error(
        `[interactSmartContractAction] Failed to extract interaction parameters: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Determine RPC URL
    const rpcUrl = alchemyApiKey
      ? `${runtime.getSetting('ZKEVM_ALCHEMY_URL') || 'https://polygonzkevm-mainnet.g.alchemy.com/v2'}/${alchemyApiKey}`
      : zkevmRpcUrl;

    if (!rpcUrl) {
      const errorMessage = 'Unable to determine RPC URL for contract interaction.';
      logger.error(`[interactSmartContractAction] ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['INTERACT_SMART_CONTRACT'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    // 1. Attempt contract interaction using Alchemy/RPC with ethers.js
    try {
      logger.info(
        `[interactSmartContractAction] Attempting contract interaction at ${interactionParams.contractAddress}`
      );

      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);

      // Create contract instance
      const contract = new Contract(
        interactionParams.contractAddress,
        interactionParams.abi,
        wallet
      );

      // Verify the method exists in the contract
      if (!contract[interactionParams.methodName]) {
        throw new Error(`Method '${interactionParams.methodName}' not found in contract ABI`);
      }

      // Check if this is a view/pure function (read-only)
      const methodAbi = interactionParams.abi.find(
        (item: any) => item.type === 'function' && item.name === interactionParams.methodName
      );
      const isReadOnly =
        methodAbi && (methodAbi.stateMutability === 'view' || methodAbi.stateMutability === 'pure');

      if (isReadOnly) {
        // For view/pure functions, call directly and return the result
        logger.info(
          `[interactSmartContractAction] Calling view/pure method '${interactionParams.methodName}' with args: ${JSON.stringify(interactionParams.args)}`
        );

        const result = await contract[interactionParams.methodName](...interactionParams.args);
        methodUsed = alchemyApiKey ? 'alchemy' : 'rpc';

        logger.info(
          `[interactSmartContractAction] View function call successful. Result: ${result?.toString()}`
        );

        const responseContent: Content = {
          text: `✅ Smart contract view function called successfully on Polygon zkEVM!

**Contract Address:** \`${interactionParams.contractAddress}\`
**Method Called:** \`${interactionParams.methodName}\`
**Arguments:** \`${JSON.stringify(interactionParams.args)}\`
**Result:** \`${result?.toString()}\`
**Method Used:** ${methodUsed}
**Network:** Polygon zkEVM

This was a read-only function call that doesn't modify blockchain state.`,
          actions: ['INTERACT_SMART_CONTRACT'],
          data: {
            contractAddress: interactionParams.contractAddress,
            methodName: interactionParams.methodName,
            args: interactionParams.args,
            result: result?.toString(),
            network: 'polygon-zkevm',
            timestamp: Date.now(),
            method: methodUsed,
            isReadOnly: true,
          },
        };

        if (callback) {
          await callback(responseContent);
        }

        return responseContent;
      }

      // For state-changing functions, prepare transaction options
      const transactionOptions: any = {};

      // Add value if provided
      if (interactionParams.value) {
        transactionOptions.value = parseEther(interactionParams.value);
      }

      // Add gas parameters
      if (interactionParams.gasLimit) {
        transactionOptions.gasLimit = interactionParams.gasLimit;
      } else {
        // Estimate gas if not provided
        try {
          const estimatedGas = await contract[interactionParams.methodName].estimateGas(
            ...interactionParams.args,
            transactionOptions
          );
          transactionOptions.gasLimit = Math.floor(Number(estimatedGas) * 1.2); // Add 20% buffer
          logger.info(`[interactSmartContractAction] Estimated gas: ${estimatedGas.toString()}`);
        } catch (gasError) {
          logger.warn(
            `[interactSmartContractAction] Gas estimation failed, using default: ${gasError}`
          );
          transactionOptions.gasLimit = '500000'; // Default gas limit for contract interaction
        }
      }

      // Handle gas pricing (EIP-1559 vs legacy)
      if (interactionParams.maxFeePerGas || interactionParams.maxPriorityFeePerGas) {
        // EIP-1559 transaction
        if (interactionParams.maxFeePerGas) {
          transactionOptions.maxFeePerGas = parseUnits(interactionParams.maxFeePerGas, 'gwei');
        }
        if (interactionParams.maxPriorityFeePerGas) {
          transactionOptions.maxPriorityFeePerGas = parseUnits(
            interactionParams.maxPriorityFeePerGas,
            'gwei'
          );
        }
        transactionOptions.type = 2; // EIP-1559
      } else if (interactionParams.gasPrice) {
        // Legacy transaction
        transactionOptions.gasPrice = parseUnits(interactionParams.gasPrice, 'gwei');
        transactionOptions.type = 0; // Legacy
      } else {
        // Use current gas price
        try {
          const feeData = await provider.getFeeData();
          if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
            transactionOptions.maxFeePerGas = feeData.maxFeePerGas;
            transactionOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
            transactionOptions.type = 2;
          } else if (feeData.gasPrice) {
            transactionOptions.gasPrice = feeData.gasPrice;
            transactionOptions.type = 0;
          }
        } catch (feeError) {
          logger.warn(`[interactSmartContractAction] Fee data fetch failed: ${feeError}`);
        }
      }

      // Call the contract method (state-changing)
      logger.info(
        `[interactSmartContractAction] Calling state-changing method '${interactionParams.methodName}' with args: ${JSON.stringify(interactionParams.args)}`
      );

      const transaction = await contract[interactionParams.methodName](
        ...interactionParams.args,
        transactionOptions
      );
      transactionHash = transaction.hash;

      logger.info(
        `[interactSmartContractAction] Contract interaction transaction sent: ${transactionHash}`
      );

      // Wait for the transaction to be mined
      const receipt = await transaction.wait();

      if (receipt && receipt.status === 1) {
        methodUsed = alchemyApiKey ? 'alchemy' : 'rpc';

        logger.info(
          `[interactSmartContractAction] Contract interaction successful. Gas used: ${receipt.gasUsed.toString()}`
        );
      } else {
        throw new Error('Contract interaction failed - transaction was reverted');
      }
    } catch (error) {
      logger.error(`[interactSmartContractAction] Contract interaction failed:`, error);
      errorMessages.push(
        `Contract interaction failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Handle result and errors
    if (transactionHash) {
      const responseContent: Content = {
        text: `✅ Smart contract interaction successful on Polygon zkEVM!

**Contract Address:** \`${interactionParams.contractAddress}\`
**Method Called:** \`${interactionParams.methodName}\`
**Arguments:** \`${JSON.stringify(interactionParams.args)}\`
**Transaction Hash:** \`${transactionHash}\`
**Method Used:** ${methodUsed}
**Network:** Polygon zkEVM

You can view the transaction on the block explorer:
- Transaction: ${transactionHash}

The contract method has been executed successfully!`,
        actions: ['INTERACT_SMART_CONTRACT'],
        data: {
          contractAddress: interactionParams.contractAddress,
          methodName: interactionParams.methodName,
          args: interactionParams.args,
          transactionHash,
          network: 'polygon-zkevm',
          timestamp: Date.now(),
          method: methodUsed,
          interactionParams: {
            gasLimit: interactionParams.gasLimit,
            value: interactionParams.value,
          },
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } else {
      // Contract interaction failed
      const errorMessage = `Failed to interact with smart contract on Polygon zkEVM. Errors: ${errorMessages.join('; ')}. Please check your contract address, ABI, method name, and arguments.`;
      logger.error(errorMessage);

      const errorContent: Content = {
        text: errorMessage,
        actions: ['INTERACT_SMART_CONTRACT'],
        data: { error: errorMessage, errors: errorMessages, interactionParams },
      };

      if (callback) {
        await callback(errorContent);
      }

      throw new Error(errorMessage);
    }
  },

  examples: [
    [
      {
        name: 'user',
        content: {
          text: 'call the transfer method on contract 0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7 with ABI [{"inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}] and args ["0x1234567890123456789012345678901234567890", "1000000000000000000"]',
        },
      },
      {
        name: 'assistant',
        content: {
          text: '✅ Smart contract interaction successful on Polygon zkEVM!\n\n**Contract Address:** `0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7`\n**Method Called:** `transfer`\n**Arguments:** `["0x1234567890123456789012345678901234567890", "1000000000000000000"]`\n**Transaction Hash:** `0xabcdef1234567890...`\n**Method Used:** alchemy\n**Network:** Polygon zkEVM\n\nYou can view the transaction on the block explorer:\n- Transaction: 0xabcdef1234567890...\n\nThe contract method has been executed successfully!',
          actions: ['INTERACT_SMART_CONTRACT'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: 'interact with contract 0x123abc... call mint function with args [100] and send 0.1 ETH',
        },
      },
      {
        name: 'assistant',
        content: {
          text: '✅ Smart contract interaction successful on Polygon zkEVM!\n\n**Contract Address:** `0x123abc...`\n**Method Called:** `mint`\n**Arguments:** `[100]`\n**Transaction Hash:** `0xdef456...`\n**Method Used:** rpc\n**Network:** Polygon zkEVM\n\nYou can view the transaction on the block explorer:\n- Transaction: 0xdef456...\n\nThe contract method has been executed successfully!',
          actions: ['INTERACT_SMART_CONTRACT'],
        },
      },
    ],
  ],
};
