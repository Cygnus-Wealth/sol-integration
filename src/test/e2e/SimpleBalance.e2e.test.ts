import { describe, it, expect } from 'vitest';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

/**
 * Simple E2E test for Solana balance fetching
 * This test directly uses Solana Web3.js to verify testnet connectivity
 */
describe('Simple Solana Balance E2E Test', () => {
  // Testnet RPC endpoints
  const TESTNET_URL = 'https://api.testnet.solana.com';
  const DEVNET_URL = 'https://api.devnet.solana.com';
  
  // Known test wallets
  const TEST_WALLETS = {
    // Solana Labs test wallet (usually has SOL on devnet)
    DEVNET_WALLET: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
    // Another test wallet
    TEST_WALLET: '7VHS8XAGP3ohBodZXpSLJpqJvjE5p5rWjGXFpRqc9gBU',
  };

  describe('Direct Connection Tests', () => {
    it('should connect to Solana devnet and fetch balance', async () => {
      const connection = new Connection(DEVNET_URL, 'confirmed');
      
      // Test connection by getting version
      const version = await connection.getVersion();
      expect(version).toBeDefined();
      expect(version['solana-core']).toBeDefined();
      
      // Fetch balance for test wallet
      const publicKey = new PublicKey(TEST_WALLETS.DEVNET_WALLET);
      const balance = await connection.getBalance(publicKey);
      
      // Balance should be a number (lamports)
      expect(typeof balance).toBe('number');
      expect(balance).toBeGreaterThanOrEqual(0);
      
      // Convert to SOL
      const solBalance = balance / LAMPORTS_PER_SOL;
      console.log(`Wallet ${TEST_WALLETS.DEVNET_WALLET} has ${solBalance} SOL on devnet`);
    }, 30000);

    it('should connect to Solana testnet and fetch slot', async () => {
      const connection = new Connection(TESTNET_URL, 'confirmed');
      
      // Get current slot as a connectivity test
      const slot = await connection.getSlot();
      expect(typeof slot).toBe('number');
      expect(slot).toBeGreaterThan(0);
      
      console.log(`Current testnet slot: ${slot}`);
    }, 30000);

    it('should fetch account info for a wallet', async () => {
      const connection = new Connection(DEVNET_URL, 'confirmed');
      const publicKey = new PublicKey(TEST_WALLETS.DEVNET_WALLET);
      
      const accountInfo = await connection.getAccountInfo(publicKey);
      
      if (accountInfo) {
        expect(accountInfo).toHaveProperty('lamports');
        expect(accountInfo).toHaveProperty('owner');
        expect(accountInfo).toHaveProperty('executable');
        expect(accountInfo.lamports).toBeGreaterThanOrEqual(0);
      } else {
        // Account might not exist, which is also valid
        expect(accountInfo).toBeNull();
      }
    }, 30000);

    it('should fetch multiple balances in parallel', async () => {
      const connection = new Connection(DEVNET_URL, 'confirmed');
      const wallets = [
        TEST_WALLETS.DEVNET_WALLET,
        TEST_WALLETS.TEST_WALLET
      ];
      
      const publicKeys = wallets.map(w => new PublicKey(w));
      
      // Fetch balances in parallel
      const balances = await Promise.all(
        publicKeys.map(pk => connection.getBalance(pk))
      );
      
      // All should return valid balances
      balances.forEach((balance, index) => {
        expect(typeof balance).toBe('number');
        expect(balance).toBeGreaterThanOrEqual(0);
        console.log(`Wallet ${wallets[index]}: ${balance / LAMPORTS_PER_SOL} SOL`);
      });
    }, 30000);

    it('should get recent blockhash', async () => {
      const connection = new Connection(DEVNET_URL, 'confirmed');
      
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      
      expect(blockhash).toBeDefined();
      expect(typeof blockhash).toBe('string');
      expect(blockhash.length).toBeGreaterThan(0);
      
      expect(lastValidBlockHeight).toBeDefined();
      expect(typeof lastValidBlockHeight).toBe('number');
      expect(lastValidBlockHeight).toBeGreaterThan(0);
      
      console.log(`Recent blockhash: ${blockhash}`);
      console.log(`Last valid block height: ${lastValidBlockHeight}`);
    }, 30000);

    it('should handle invalid public key gracefully', async () => {
      const connection = new Connection(DEVNET_URL, 'confirmed');
      
      // This should throw when creating PublicKey
      expect(() => {
        new PublicKey('invalid-address');
      }).toThrow();
    });

    it('should fetch token accounts for a wallet', async () => {
      const connection = new Connection(DEVNET_URL, 'confirmed');
      const publicKey = new PublicKey(TEST_WALLETS.DEVNET_WALLET);
      
      // Fetch all token accounts owned by this wallet
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        publicKey,
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
      );
      
      expect(tokenAccounts).toBeDefined();
      expect(tokenAccounts.value).toBeDefined();
      expect(Array.isArray(tokenAccounts.value)).toBe(true);
      
      console.log(`Found ${tokenAccounts.value.length} token accounts`);
      
      // Log token details if any exist
      tokenAccounts.value.forEach((account) => {
        const parsed = account.account.data.parsed;
        if (parsed && parsed.info) {
          const { mint, tokenAmount } = parsed.info;
          console.log(`Token: ${mint}, Balance: ${tokenAmount.uiAmountString}`);
        }
      });
    }, 30000);
  });

  describe('Connection Pool Tests', () => {
    it('should work with multiple RPC endpoints', async () => {
      const endpoints = [
        DEVNET_URL,
        'https://rpc.ankr.com/solana_devnet',
      ];
      
      const results = await Promise.allSettled(
        endpoints.map(async (endpoint) => {
          const connection = new Connection(endpoint, 'confirmed');
          const slot = await connection.getSlot();
          return { endpoint, slot };
        })
      );
      
      // At least one should succeed
      const successful = results.filter(r => r.status === 'fulfilled');
      expect(successful.length).toBeGreaterThan(0);
      
      successful.forEach((result) => {
        if (result.status === 'fulfilled') {
          console.log(`${result.value.endpoint}: slot ${result.value.slot}`);
        }
      });
    }, 30000);
  });
});