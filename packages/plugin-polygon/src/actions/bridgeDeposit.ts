import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  composePromptFromState,
  ModelType,
  type ActionExample,
  type TemplateType,
  parseJSONObjectFromText,
} from '@elizaos/core';
import {
  createConfig,
  executeRoute,
  type ExtendedChain,
  getRoutes,
  type LiFiStep,
  type Route,
  type ChainKey,
} from '@lifi/sdk';
import {
  createWalletClient,
  http,
  type WalletClient,
  parseEther,
  type PublicClient,
  createPublicClient,
  fallback,
  type Address,
  type Hex,
  type Transport,
  type Account,
  type Chain,
} from 'viem';
import { type WalletProvider, initWalletProvider } from '../providers/PolygonWalletProvider';
import { bridgeDepositPolygonTemplate } from '../templates';

interface BridgeParams {
  fromChain: string;
  toChain: string;
  fromToken: Address;
  toToken: Address;
  amount: string;
  toAddress?: Address;
}
interface Transaction {
  hash: `0x${string}`;
  from: Address;
  to: Address;
  value: bigint;
  chainId: number;
  data?: Hex;
  logs?: Array<unknown>;
}

class PolygonBridgeActionRunner {
  private config;
  private walletProvider: WalletProvider;

  constructor(walletProvider: WalletProvider) {
    this.walletProvider = walletProvider;
    const extendedChains = Object.values(this.walletProvider.chains).map((chainConfig: Chain) => {
      const rpcUrls = chainConfig.rpcUrls.custom?.http || chainConfig.rpcUrls.default.http;
      const blockExplorerUrl = chainConfig.blockExplorers?.default?.url || '';

      return {
        ...chainConfig,
        key: chainConfig.name.toLowerCase().replace(/\s+/g, '-') as ChainKey,
        chainType: 'EVM',
        coin: chainConfig.nativeCurrency.symbol,
        mainnet: !chainConfig.testnet,
        logoURI: '',
        diamondAddress: undefined,
        nativeToken: {
          address: '0x0000000000000000000000000000000000000000',
          chainId: chainConfig.id,
          symbol: chainConfig.nativeCurrency.symbol,
          decimals: chainConfig.nativeCurrency.decimals,
          name: chainConfig.nativeCurrency.name,
          priceUSD: '0',
          logoURI: '',
          coinKey: chainConfig.nativeCurrency.symbol,
        },
        metamask: {
          chainId: `0x${chainConfig.id.toString(16)}`,
          blockExplorerUrls: blockExplorerUrl ? [blockExplorerUrl] : [],
          chainName: chainConfig.name,
          nativeCurrency: chainConfig.nativeCurrency,
          rpcUrls: rpcUrls.slice(),
        },
      } as ExtendedChain;
    });

    this.config = createConfig({
      integrator: 'ElizaOS-PolygonPlugin',
      chains: extendedChains,
    });
  }
  async bridge(params: BridgeParams): Promise<Transaction> {
    const walletClient = this.walletProvider.getWalletClient(params.fromChain);
    const [fromAddress] = await walletClient.getAddresses();

    const routes = await getRoutes({
      fromChainId: this.walletProvider.getChainConfigs(params.fromChain).id,
      toChainId: this.walletProvider.getChainConfigs(params.toChain).id,
      fromTokenAddress: params.fromToken,
      toTokenAddress: params.toToken,
      fromAmount: parseEther(params.amount).toString(),
      fromAddress: fromAddress,
      toAddress: params.toAddress || fromAddress,
    });

    if (!routes.routes.length) throw new Error('No routes found');

    const execution = await executeRoute(routes.routes[0], this.config);
    const process = execution.steps[0]?.execution?.process[0];

    if (!process?.status || process.status === 'FAILED') {
      throw new Error('Transaction failed');
    }

    return {
      hash: process.txHash as `0x${string}`,
      from: fromAddress,
      to: routes.routes[0].steps[0].estimate.approvalAddress as `0x${string}`,
      value: BigInt(params.amount),
      chainId: this.walletProvider.getChainConfigs(params.fromChain).id,
    };
  }
}

export const bridgeDepositAction: Action = {
  name: 'BRIDGE_DEPOSIT_POLYGON',
  similes: ['POLYGON_BRIDGE_FUNDS', 'MOVE_ETH_TO_POLYGON_LIFI'],
  description: 'Initiates a deposit/bridge using LiFi.',
  validate: async (runtime: IAgentRuntime, _m: Memory, _s: State | undefined): Promise<boolean> => {
    logger.debug('Validating BRIDGE_DEPOSIT_POLYGON...');
    const checks = [
      runtime.getSetting('WALLET_PRIVATE_KEY'),
      runtime.getSetting('POLYGON_PLUGINS_ENABLED'),
    ];
    if (checks.some((check) => !check)) {
      logger.error('Required settings (WALLET_PRIVATE_KEY, POLYGON_PLUGINS_ENABLED) missing.');
      return false;
    }
    try {
      await initWalletProvider(runtime);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error(`WalletProvider initialization failed during validation: ${errMsg} `);
      return false;
    }
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _o: unknown,
    cb: HandlerCallback | undefined,
    _rs: Memory[] | undefined
  ) => {
    logger.info('Handling BRIDGE_DEPOSIT_POLYGON for:', message.id);
    try {
      const walletProvider = await initWalletProvider(runtime);
      const actionRunner = new PolygonBridgeActionRunner(walletProvider);
      const prompt = composePromptFromState({
        state,
        template: bridgeDepositPolygonTemplate as unknown as TemplateType,
      });
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });
      let paramsJson: BridgeParams | { error: string };
      try {
        paramsJson = parseJSONObjectFromText(modelResponse) as BridgeParams | { error: string };
        logger.debug('Bridge parameters extracted:', paramsJson);

        // Check if the model response contains an error
        if ('error' in paramsJson) {
          logger.warn(`Bridge action: Model responded with error: ${paramsJson.error}`);
          throw new Error(paramsJson.error);
        }

        // At this point, paramsJson must be BridgeParams
        const bridgeOptions: BridgeParams = paramsJson;
      } catch (e) {
        logger.error('Failed to parse LLM response for bridge params:', modelResponse, e);
        throw new Error('Could not understand bridge parameters.');
      }
      if (
        !bridgeOptions.fromChain ||
        !bridgeOptions.toChain ||
        !bridgeOptions.fromToken ||
        !bridgeOptions.toToken ||
        !bridgeOptions.amount
      ) {
        throw new Error('Incomplete bridge parameters extracted.');
      }

      logger.debug('Parsed bridge options:', bridgeOptions);
      const bridgeResp = await actionRunner.bridge(bridgeOptions);
      const successMessage = `Initiated bridge: ${bridgeOptions.amount} token from ${bridgeOptions.fromChain} to ${bridgeOptions.toChain}.TxHash: ${bridgeResp.hash} `;
      logger.info(successMessage);
      if (cb) {
        await cb({
          text: successMessage,
          content: { success: true, hash: bridgeResp.hash },
          actions: ['BRIDGE_DEPOSIT_POLYGON'],
          source: message.content.source,
        });
      }
      return { success: true, hash: bridgeResp.hash };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('BRIDGE_DEPOSIT_POLYGON handler error:', errMsg, error);
      if (cb) {
        await cb({
          text: `Error bridging: ${errMsg} `,
          actions: ['BRIDGE_DEPOSIT_POLYGON'],
          source: message.content.source,
        });
      }
      return { success: false, error: errMsg };
    }
  },
  examples: [
    [
      {
        name: 'user',
        content: { text: 'Bridge 0.5 WETH from Polygon to Ethereum mainnet.' },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: 'Move 100 USDC from Arbitrum to Polygon, send it to 0x123...',
        },
      },
    ],
  ],
};
