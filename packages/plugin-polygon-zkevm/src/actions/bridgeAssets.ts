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
import { JsonRpcProvider, Wallet, Contract, parseEther, formatEther, parseUnits } from 'ethers';
import { bridgeAssetsTemplate } from '../templates';
import { callLLMWithTimeout } from '../utils/llmHelpers';

// Polygon zkEVM Bridge Contract ABI (simplified for deposit/withdraw)
const BRIDGE_ABI = [
  // Deposit ETH
  'function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes permitData) external payable',
  // Deposit ERC20
  'function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes permitData) external',
  // Claim assets
  'function claimAsset(bytes32[32] smtProof, uint32 index, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originTokenAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata) external',
  // Events
  'event BridgeEvent(uint8 leafType, uint32 originNetwork, address originAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata, uint32 depositCount)',
  'event ClaimEvent(uint32 index, uint32 originNetwork, address originAddress, address destinationAddress, uint256 amount)',
];

// ERC20 ABI for approvals
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
];

// Bridge contract addresses
const BRIDGE_ADDRESSES = {
  mainnet: '0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe', // Ethereum mainnet bridge
  zkevm: '0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe', // zkEVM bridge (same address)
};

// Network IDs
const NETWORK_IDS = {
  ethereum: 0,
  zkevm: 1,
};

export const bridgeAssetsAction: Action = {
  name: 'BRIDGE_ASSETS',
  similes: ['BRIDGE_TOKENS', 'DEPOSIT_ASSETS', 'WITHDRAW_ASSETS', 'BRIDGE_ETH', 'BRIDGE_ERC20'],
  description: 'Bridges assets (ETH or ERC-20 tokens) between Ethereum and Polygon zkEVM.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const privateKey = runtime.getSetting('PRIVATE_KEY') || process.env.PRIVATE_KEY;
    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY') || process.env.ALCHEMY_API_KEY;
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL') || process.env.ZKEVM_RPC_URL;

    if (!privateKey) {
      logger.error('[bridgeAssetsAction] PRIVATE_KEY is required for bridging assets');
      return false;
    }

    if (!alchemyApiKey && !zkevmRpcUrl) {
      logger.error('[bridgeAssetsAction] Either ALCHEMY_API_KEY or ZKEVM_RPC_URL is required');
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[bridgeAssetsAction] Handler called!');

    const privateKey = runtime.getSetting('PRIVATE_KEY') || process.env.PRIVATE_KEY;
    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY') || process.env.ALCHEMY_API_KEY;
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL') || process.env.ZKEVM_RPC_URL;

    if (!privateKey) {
      const errorMessage = 'PRIVATE_KEY is required for bridging assets.';
      logger.error(`[bridgeAssetsAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['BRIDGE_ASSETS'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    if (!alchemyApiKey && !zkevmRpcUrl) {
      const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
      logger.error(`[bridgeAssetsAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['BRIDGE_ASSETS'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let bridgeParams: any | null = null;
    let errorMessages: string[] = [];

    // Extract bridge parameters using LLM
    try {
      bridgeParams = await callLLMWithTimeout<{
        tokenAddress: string | null;
        amount: string;
        direction: 'deposit' | 'withdraw';
        gasLimit?: string | number;
        gasPrice?: string;
        maxFeePerGas?: string;
        maxPriorityFeePerGas?: string;
      }>(runtime, state, bridgeAssetsTemplate, 'bridgeAssetsAction');

      // Check if the model returned an error field
      if (bridgeParams?.error) {
        logger.error('[bridgeAssetsAction] LLM returned an error:', bridgeParams?.error);
        throw new Error(bridgeParams?.error);
      }

      // Validate required parameters
      if (!bridgeParams?.amount || !bridgeParams?.direction) {
        throw new Error('Missing required bridge parameters: amount and direction are required.');
      }

      if (!['deposit', 'withdraw'].includes(bridgeParams.direction)) {
        throw new Error('Invalid direction. Must be "deposit" or "withdraw".');
      }
    } catch (error) {
      logger.debug(
        '[bridgeAssetsAction] LLM parameter extraction failed',
        error instanceof Error ? error : undefined
      );
      throw new Error(
        `[bridgeAssetsAction] Failed to extract bridge parameters from input: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      // Setup providers and wallet
      let sourceProvider: JsonRpcProvider;
      let destinationProvider: JsonRpcProvider;

      if (bridgeParams.direction === 'deposit') {
        // Deposit: Ethereum -> zkEVM
        if (alchemyApiKey) {
          sourceProvider = new JsonRpcProvider(
            `https://eth-mainnet.g.alchemy.com/v2/${alchemyApiKey}`
          );
        } else {
          sourceProvider = new JsonRpcProvider('https://ethereum.publicnode.com'); // Fallback
        }

        if (alchemyApiKey) {
          const zkevmAlchemyUrl =
            runtime.getSetting('ZKEVM_ALCHEMY_URL') ||
            'https://polygonzkevm-mainnet.g.alchemy.com/v2';
          destinationProvider = new JsonRpcProvider(`${zkevmAlchemyUrl}/${alchemyApiKey}`);
        } else if (zkevmRpcUrl) {
          destinationProvider = new JsonRpcProvider(zkevmRpcUrl);
        } else {
          destinationProvider = new JsonRpcProvider('https://zkevm-rpc.com'); // Fallback
        }
      } else {
        // Withdraw: zkEVM -> Ethereum
        if (alchemyApiKey) {
          const zkevmAlchemyUrl =
            runtime.getSetting('ZKEVM_ALCHEMY_URL') ||
            'https://polygonzkevm-mainnet.g.alchemy.com/v2';
          sourceProvider = new JsonRpcProvider(`${zkevmAlchemyUrl}/${alchemyApiKey}`);
        } else if (zkevmRpcUrl) {
          sourceProvider = new JsonRpcProvider(zkevmRpcUrl);
        } else {
          sourceProvider = new JsonRpcProvider('https://zkevm-rpc.com'); // Fallback
        }

        if (alchemyApiKey) {
          destinationProvider = new JsonRpcProvider(
            `https://eth-mainnet.g.alchemy.com/v2/${alchemyApiKey}`
          );
        } else {
          destinationProvider = new JsonRpcProvider('https://ethereum.publicnode.com'); // Fallback
        }
      }

      const wallet = new Wallet(privateKey, sourceProvider);
      const bridgeAddress =
        bridgeParams.direction === 'deposit' ? BRIDGE_ADDRESSES.mainnet : BRIDGE_ADDRESSES.zkevm;
      const bridgeContract = new Contract(bridgeAddress, BRIDGE_ABI, wallet);

      // Determine network IDs
      const sourceNetworkId =
        bridgeParams.direction === 'deposit' ? NETWORK_IDS.ethereum : NETWORK_IDS.zkevm;
      const destinationNetworkId =
        bridgeParams.direction === 'deposit' ? NETWORK_IDS.zkevm : NETWORK_IDS.ethereum;

      let txHash: string;
      let amount: bigint;
      let tokenAddress = bridgeParams.tokenAddress;

      // Handle ETH vs ERC20
      if (
        !tokenAddress ||
        tokenAddress.toLowerCase() === 'null' ||
        tokenAddress === '0x0000000000000000000000000000000000000000'
      ) {
        // Bridge ETH
        amount = parseEther(bridgeParams.amount);
        tokenAddress = '0x0000000000000000000000000000000000000000'; // ETH address

        logger.info(
          `[bridgeAssetsAction] Bridging ${bridgeParams.amount} ETH from ${bridgeParams.direction === 'deposit' ? 'Ethereum' : 'zkEVM'} to ${bridgeParams.direction === 'deposit' ? 'zkEVM' : 'Ethereum'}`
        );

        // Prepare transaction options
        const txOptions: any = {
          value: amount,
        };

        // Add gas options if provided
        if (bridgeParams.gasLimit) {
          txOptions.gasLimit = bridgeParams.gasLimit;
        }
        if (bridgeParams.gasPrice) {
          txOptions.gasPrice = parseUnits(bridgeParams.gasPrice, 'gwei');
        }
        if (bridgeParams.maxFeePerGas) {
          txOptions.maxFeePerGas = parseUnits(bridgeParams.maxFeePerGas, 'gwei');
        }
        if (bridgeParams.maxPriorityFeePerGas) {
          txOptions.maxPriorityFeePerGas = parseUnits(bridgeParams.maxPriorityFeePerGas, 'gwei');
        }

        // Execute bridge transaction
        const tx = await bridgeContract.bridgeAsset(
          destinationNetworkId,
          wallet.address, // destination address (same as sender)
          amount,
          tokenAddress,
          true, // forceUpdateGlobalExitRoot
          '0x', // permitData (empty for ETH)
          txOptions
        );

        txHash = tx.hash;
        logger.info(`[bridgeAssetsAction] ETH bridge transaction sent: ${txHash}`);
      } else {
        // Bridge ERC20 token
        const tokenContract = new Contract(tokenAddress, ERC20_ABI, wallet);

        // Get token decimals
        const decimals = await tokenContract.decimals();
        amount = parseUnits(bridgeParams.amount, decimals);

        logger.info(
          `[bridgeAssetsAction] Bridging ${bridgeParams.amount} tokens (${tokenAddress}) from ${bridgeParams.direction === 'deposit' ? 'Ethereum' : 'zkEVM'} to ${bridgeParams.direction === 'deposit' ? 'zkEVM' : 'Ethereum'}`
        );

        // Check and approve if necessary
        const allowance = await tokenContract.allowance(wallet.address, bridgeAddress);
        if (allowance < amount) {
          logger.info(`[bridgeAssetsAction] Approving token spend...`);
          const approveTx = await tokenContract.approve(bridgeAddress, amount);
          await approveTx.wait();
          logger.info(`[bridgeAssetsAction] Token approval confirmed: ${approveTx.hash}`);
        }

        // Prepare transaction options
        const txOptions: any = {};

        // Add gas options if provided
        if (bridgeParams.gasLimit) {
          txOptions.gasLimit = bridgeParams.gasLimit;
        }
        if (bridgeParams.gasPrice) {
          txOptions.gasPrice = parseUnits(bridgeParams.gasPrice, 'gwei');
        }
        if (bridgeParams.maxFeePerGas) {
          txOptions.maxFeePerGas = parseUnits(bridgeParams.maxFeePerGas, 'gwei');
        }
        if (bridgeParams.maxPriorityFeePerGas) {
          txOptions.maxPriorityFeePerGas = parseUnits(bridgeParams.maxPriorityFeePerGas, 'gwei');
        }

        // Execute bridge transaction
        const tx = await bridgeContract.bridgeAsset(
          destinationNetworkId,
          wallet.address, // destination address (same as sender)
          amount,
          tokenAddress,
          true, // forceUpdateGlobalExitRoot
          '0x', // permitData (empty)
          txOptions
        );

        txHash = tx.hash;
        logger.info(`[bridgeAssetsAction] ERC20 bridge transaction sent: ${txHash}`);
      }

      // Wait for transaction confirmation
      const receipt = await sourceProvider.waitForTransaction(txHash);

      if (!receipt) {
        throw new Error('Transaction receipt not found');
      }

      // Extract bridge event data for ticket ID
      let bridgeTicketId: string | null = null;
      let depositCount: number | null = null;

      for (const log of receipt.logs) {
        try {
          const parsedLog = bridgeContract.interface.parseLog({
            topics: log.topics,
            data: log.data,
          });

          if (parsedLog && parsedLog.name === 'BridgeEvent') {
            depositCount = parsedLog.args.depositCount;
            bridgeTicketId = `${sourceNetworkId}-${depositCount}`;
            logger.info(`[bridgeAssetsAction] Bridge ticket ID: ${bridgeTicketId}`);
            break;
          }
        } catch (error) {
          // Skip logs that don't match our interface
          continue;
        }
      }

      const responseContent: Content = {
        text: `Successfully ${bridgeParams.direction === 'deposit' ? 'deposited' : 'withdrew'} ${bridgeParams.amount} ${tokenAddress === '0x0000000000000000000000000000000000000000' ? 'ETH' : 'tokens'} ${bridgeParams.direction === 'deposit' ? 'to' : 'from'} Polygon zkEVM!

Transaction Hash: ${txHash}
${bridgeTicketId ? `Bridge Ticket ID: ${bridgeTicketId}` : ''}
Status: Confirmed (${receipt.status === 1 ? 'Success' : 'Failed'})
Gas Used: ${receipt.gasUsed.toString()}
Block Number: ${receipt.blockNumber}

${
  bridgeParams.direction === 'deposit'
    ? 'Note: Assets will be available on zkEVM after the bridge processes the deposit (usually within a few minutes).'
    : 'Note: For withdrawals, you will need to wait for the challenge period and then claim your assets on Ethereum mainnet.'
}`,
        actions: ['BRIDGE_ASSETS'],
        data: {
          txHash,
          bridgeTicketId,
          depositCount,
          direction: bridgeParams.direction,
          tokenAddress,
          amount: bridgeParams.amount,
          sourceNetwork: bridgeParams.direction === 'deposit' ? 'ethereum' : 'zkevm',
          destinationNetwork: bridgeParams.direction === 'deposit' ? 'zkevm' : 'ethereum',
          gasUsed: receipt.gasUsed.toString(),
          blockNumber: receipt.blockNumber,
          status: receipt.status === 1 ? 'success' : 'failed',
          timestamp: Date.now(),
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      const errorMessage = `Failed to bridge assets: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(`[bridgeAssetsAction] ${errorMessage}`);

      const errorContent: Content = {
        text: errorMessage,
        actions: ['BRIDGE_ASSETS'],
        data: {
          error: errorMessage,
          bridgeParams,
          timestamp: Date.now(),
        },
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
          text: 'bridge 0.1 ETH from ethereum to polygon zkevm',
        },
      },
      {
        name: 'assistant',
        content: {
          text: 'Successfully deposited 0.1 ETH to Polygon zkEVM!\n\nTransaction Hash: 0x1234567890abcdef...\nBridge Ticket ID: 0-12345\nStatus: Confirmed (Success)\nGas Used: 150000\nBlock Number: 18500000\n\nNote: Assets will be available on zkEVM after the bridge processes the deposit (usually within a few minutes).',
          actions: ['BRIDGE_ASSETS'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: 'withdraw 100 USDC from polygon zkevm to ethereum',
        },
      },
      {
        name: 'assistant',
        content: {
          text: 'Successfully withdrew 100 tokens from Polygon zkEVM!\n\nTransaction Hash: 0xabcdef1234567890...\nBridge Ticket ID: 1-67890\nStatus: Confirmed (Success)\nGas Used: 200000\nBlock Number: 8500000\n\nNote: For withdrawals, you will need to wait for the challenge period and then claim your assets on Ethereum mainnet.',
          actions: ['BRIDGE_ASSETS'],
        },
      },
    ],
  ],
};
