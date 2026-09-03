/**
 * Prints a fresh 32-byte master key. Put it in CREDENTIAL_MASTER_KEY for local development;
 * in production store it in Azure Key Vault and load it at boot instead.
 *
 * Changing this key makes every stored credential undecryptable, so treat it as permanent
 * unless you are running a deliberate rewrap.
 */
import { generateMasterKey } from '../src/services/vault';

console.log(generateMasterKey());
