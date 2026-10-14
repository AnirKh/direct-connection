/* Entry point bundled into vendor/noble.js — see that file's header.
   Pulls only what pake.js uses from the audited @noble packages and hands
   them to the page as one global, so the browser gets the same curve library
   Node gets from node_modules. */
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { hkdf } from "@noble/hashes/hkdf";
import * as utils from "@noble/hashes/utils";
window.DCNoble = { p256, sha256, hmac, hkdf, utils };
