import { hexToBin } from '@bitauth/libauth';
import {
  asmToScript,
  encodeBool,
  encodeInt,
  encodeString,
  Op,
  OpOrData,
  PrimitiveType,
  resultingType,
  Script,
  scriptToAsm,
} from '@cashscript/utils';
import {
  ContractNode,
  ParameterNode,
  VariableDefinitionNode,
  FunctionDefinitionNode,
  AssignNode,
  IdentifierNode,
  BranchNode,
  CastNode,
  FunctionCallNode,
  UnaryOpNode,
  BinaryOpNode,
  BoolLiteralNode,
  IntLiteralNode,
  HexLiteralNode,
  StringLiteralNode,
  BlockNode,
  TimeOpNode,
  ArrayNode,
  TupleIndexOpNode,
  RequireNode,
  SourceFileNode,
  Node,
  InstantiationNode,
  TupleAssignmentNode,
} from '../ast/AST';
import AstTraversal from '../ast/AstTraversal';
import { GlobalFunction, PreimageField, Class } from '../ast/Globals';
import { PreimageParts } from './preimage';
import { BinaryOperator } from '../ast/Operator';
import {
  compileBinaryOp,
  compileCast,
  compileGlobalFunction,
  compileTimeOp,
  compileUnaryOp,
} from './utils';

export default class GenerateTargetTraversal extends AstTraversal {
  output: Script = [];
  stack: string[] = [];

  private scopeDepth = 0;
  private currentFunction: FunctionDefinitionNode;
  private isCheckSigVerify = false;
  private covenantNeedsToBeVerified = false;

  private emit(op: OpOrData | OpOrData[]): void {
    if (Array.isArray(op)) {
      this.output.push(...op);
    } else {
      this.output.push(op);
    }
  }

  private pushToStack(value: string, pushToBottom?: boolean): void {
    if (pushToBottom) {
      this.stack.push(value);
    } else {
      this.stack.unshift(value);
    }
  }

  private popFromStack(count: number = 1): void {
    for (let i = 0; i < count; i += 1) {
      this.stack.shift();
    }
  }

  private removeFromStack(i: number): void {
    this.stack.splice(i, 1);
  }

  private nipFromStack(): void {
    this.stack.splice(1, 1);
  }

  private getStackIndex(value: string): number {
    const index = this.stack.indexOf(value);
    if (index === -1) throw new Error(); // Should not happen
    return index;
  }

  visitSourceFile(node: SourceFileNode): Node {
    node.contract = this.visit(node.contract) as ContractNode;

    // Minimally encode output by going Script -> ASM -> Script
    this.output = asmToScript(scriptToAsm(this.output));

    return node;
  }

  visitContract(node: ContractNode): Node {
    node.parameters = this.visitList(node.parameters) as ParameterNode[];
    if (node.functions.length === 1) {
      node.functions = this.visitList(node.functions) as FunctionDefinitionNode[];
    } else {
      this.pushToStack('$$', true);
      node.functions = node.functions.map((f, i) => {
        const stackCopy = [...this.stack];
        const selectorIndex = this.getStackIndex('$$');
        this.emit(encodeInt(selectorIndex));
        if (i === node.functions.length - 1) {
          this.emit(Op.OP_ROLL);
          this.removeFromStack(selectorIndex);
        } else {
          this.emit(Op.OP_PICK);
        }

        // All functions are if-else statements, except the final one which is
        // enforced with NUMEQUALVERIFY
        this.emit(encodeInt(i));
        this.emit(Op.OP_NUMEQUAL);
        if (i < node.functions.length - 1) {
          this.emit(Op.OP_IF);
        } else {
          this.emit(Op.OP_VERIFY);
        }

        f = this.visit(f) as FunctionDefinitionNode;

        if (i < node.functions.length - 1) {
          this.emit(Op.OP_ELSE);
        }

        this.stack = [...stackCopy];
        return f;
      });
      for (let i = 0; i < node.functions.length - 1; i += 1) {
        this.emit(Op.OP_ENDIF);
      }
    }

    return node;
  }

  visitFunctionDefinition(node: FunctionDefinitionNode): Node {
    this.currentFunction = node;

    if (node.preimageFields.length > 0) {
      this.covenantNeedsToBeVerified = true;
      this.decodePreimage(node.preimageFields);
    }

    node.parameters = this.visitList(node.parameters) as ParameterNode[];
    node.body = this.visit(node.body) as BlockNode;

    this.removeFinalVerify();
    this.cleanStack();

    return node;
  }

  decodePreimage(fields: PreimageField[]): void {
    // Preimage is first arg after selector
    this.pushToStack('$preimage', true);
    this.emit(encodeInt(this.getStackIndex('$preimage')));
    this.emit(Op.OP_PICK);

    const cuts = {
      fromStart: 0,
      fromEnd: 0,
    };

    // Fields before bytecode needs to be cut from the front
    const beforeBytecode = [
      PreimageField.VERSION, PreimageField.HASHPREVOUTS,
      PreimageField.HASHSEQUENCE, PreimageField.OUTPOINT,
    ].filter((field) => fields.includes(field));

    beforeBytecode.forEach((field) => {
      const part = PreimageParts[field];
      const start = part.fromStart - cuts.fromStart;
      if (start !== 0) {
        this.emit(encodeInt(start));
        this.emit(Op.OP_SPLIT);
        this.emit(Op.OP_NIP);
      }

      this.emit(encodeInt(part.size));
      this.emit(Op.OP_SPLIT);

      this.pushToStack(field);
      cuts.fromStart = part.fromStart + part.size;
    });

    // Bytecode potentially needs a cut from the front and from the back
    if (fields.includes(PreimageField.BYTECODE)) {
      const part = PreimageParts[PreimageField.BYTECODE];
      const start = part.fromStart - cuts.fromStart;

      // Always add this split, since the VarInt needs to be cut off any way
      // See ReplaceBytecodeNop.ts
      this.emit(Op.OP_NOP);
      this.emit(encodeInt(start));
      this.emit(Op.OP_SPLIT);
      this.emit(Op.OP_NIP);

      this.emit(Op.OP_SIZE);
      this.emit(encodeInt(part.size));
      this.emit(Op.OP_SUB);
      this.emit(Op.OP_SPLIT);

      this.pushToStack(PreimageField.BYTECODE);
      cuts.fromStart = 0;
      cuts.fromEnd = part.size;
    }

    // Fields after bytecode potentially need a cut from the back,
    // after which they go back to cutting from the front
    const afterBytecode = [
      PreimageField.VALUE, PreimageField.SEQUENCE, PreimageField.HASHOUTPUTS,
      PreimageField.LOCKTIME, PreimageField.HASHTYPE,
    ].filter((field) => fields.includes(field));

    afterBytecode.forEach((field) => {
      const part = PreimageParts[field];
      const start = part.fromStart - cuts.fromStart;
      const end = part.fromEnd - cuts.fromEnd;

      if (end > 0) {
        this.emit(Op.OP_SIZE);
        this.emit(encodeInt(end));
        this.emit(Op.OP_SUB);
        this.emit(Op.OP_SPLIT);
        this.emit(Op.OP_NIP);
      } else if (start !== 0) {
        this.emit(encodeInt(start));
        this.emit(Op.OP_SPLIT);
        this.emit(Op.OP_NIP);
      }

      this.pushToStack(field);
      if (field === PreimageField.HASHTYPE) return;

      this.emit(encodeInt(part.size));
      this.emit(Op.OP_SPLIT);

      cuts.fromStart = part.fromStart + part.size;
      cuts.fromEnd = part.fromEnd - part.size;
    });

    // Drop remainder
    if (!fields.includes(PreimageField.HASHTYPE)) {
      this.emit(Op.OP_DROP);
    }
  }

  removeFinalVerify(): void {
    // After EnsureFinalRequireTraversal, we know that the final opcodes are either
    // "OP_VERIFY", "OP_CHECK{LOCKTIME|SEQUENCE}VERIFY OP_DROP" or "OP_ENDIF"

    const finalOp = this.output.pop() as Op;

    // If the final op is OP_VERIFY and the stack size is less than 4 we remove it from the script
    // - We have the stack size check because it is more efficient to use 2DROP rather than NIP
    //   if >= 4 elements are left (5 including final value) (e.g. 2DROP 2DROP 1 < NIP NIP NIP NIP)
    if (finalOp === Op.OP_VERIFY && this.stack.length < 4) {
      // Since the final value is no longer popped from the stack by OP_VERIFY,
      // we add it back to the stack
      this.pushToStack('(value)');
    } else {
      this.emit(finalOp);

      // At this point there is no verification value left on the stack:
      //  - scoped stack is cleared inside branch ended by OP_ENDIF
      //  - OP_CHECK{LOCKTIME|SEQUENCE}VERIFY OP_DROP does not leave a verification value
      // so we add OP_1 to the script (indicating success)
      this.emit(Op.OP_1);
      this.pushToStack('(value)');
    }
  }

  cleanStack(): void {
    // Keep final verification value, OP_NIP the other stack values
    const stackSize = this.stack.length;
    for (let i = 0; i < stackSize - 1; i += 1) {
      this.emit(Op.OP_NIP);
      this.nipFromStack();
    }
  }

  visitParameter(node: ParameterNode): Node {
    this.pushToStack(node.name, true);
    return node;
  }

  visitVariableDefinition(node: VariableDefinitionNode): Node {
    node.expression = this.visit(node.expression);
    this.popFromStack();
    this.pushToStack(node.name);
    return node;
  }

  visitTupleAssignment(node: TupleAssignmentNode): Node {
    node.tuple = this.visit(node.tuple);
    this.popFromStack(2);
    this.pushToStack(node.var1.name);
    this.pushToStack(node.var2.name);
    return node;
  }

  visitAssign(node: AssignNode): Node {
    node.expression = this.visit(node.expression);
    if (this.scopeDepth > 0) {
      this.emitReplace(this.getStackIndex(node.identifier.name));
      this.popFromStack();
    } else {
      this.popFromStack();
      this.pushToStack(node.identifier.name);
    }
    return node;
  }

  // This algorithm can be optimised for hardcoded depths
  // See thesis for explanation
  emitReplace(index: number): void {
    this.emit(encodeInt(index));
    this.emit(Op.OP_ROLL);
    this.emit(Op.OP_DROP);
    for (let i = 0; i < index - 1; i += 1) {
      this.emit(Op.OP_SWAP);
      if (i < index - 2) {
        this.emit(Op.OP_TOALTSTACK);
      }
    }
    for (let i = 0; i < index - 2; i += 1) {
      this.emit(Op.OP_FROMALTSTACK);
    }
  }

  visitTimeOp(node: TimeOpNode): Node {
    node.expression = this.visit(node.expression);
    this.emit(compileTimeOp(node.timeOp));
    this.popFromStack();
    return node;
  }

  visitRequire(node: RequireNode): Node {
    if (this.containsCheckSig(node)) this.isCheckSigVerify = true;
    node.expression = this.visit(node.expression);
    this.isCheckSigVerify = false;

    this.emit(Op.OP_VERIFY);
    this.popFromStack();
    return node;
  }

  containsCheckSig(node: RequireNode): boolean {
    if (!(node.expression instanceof FunctionCallNode)) return false;
    if (node.expression.identifier.name !== GlobalFunction.CHECKSIG) return false;
    return true;
  }

  visitBranch(node: BranchNode): Node {
    node.condition = this.visit(node.condition);
    this.popFromStack();

    this.scopeDepth += 1;
    this.emit(Op.OP_IF);

    let stackDepth = this.stack.length;
    node.ifBlock = this.visit(node.ifBlock);
    this.removeScopedVariables(stackDepth);

    if (node.elseBlock) {
      this.emit(Op.OP_ELSE);
      stackDepth = this.stack.length;
      node.elseBlock = this.visit(node.elseBlock);
      this.removeScopedVariables(stackDepth);
    }

    this.emit(Op.OP_ENDIF);
    this.scopeDepth -= 1;

    return node;
  }

  removeScopedVariables(depthBeforeScope: number): void {
    const dropCount = this.stack.length - depthBeforeScope;
    for (let i = 0; i < dropCount; i += 1) {
      this.emit(Op.OP_DROP);
      this.popFromStack();
    }
  }

  visitCast(node: CastNode): Node {
    node.expression = this.visit(node.expression);

    // Special case for sized bytes cast, since it has another node to traverse
    if (node.size) {
      node.size = this.visit(node.size);
      this.emit(Op.OP_NUM2BIN);
      this.popFromStack();
    }

    this.emit(compileCast(node.expression.type as PrimitiveType, node.type));
    this.popFromStack();
    this.pushToStack('(value)');
    return node;
  }

  visitFunctionCall(node: FunctionCallNode): Node {
    if (node.identifier.name === GlobalFunction.CHECKMULTISIG) {
      return this.visitMultiSig(node);
    }

    node.parameters = this.visitList(node.parameters);

    if (this.needsToVerifyCovenant(node)) this.verifyCovenant();

    this.emit(compileGlobalFunction(node.identifier.name as GlobalFunction));
    this.popFromStack(node.parameters.length);
    this.pushToStack('(value)');

    return node;
  }

  visitMultiSig(node: FunctionCallNode): Node {
    this.emit(encodeBool(false));
    node.parameters = this.visitList(node.parameters);
    this.emit(Op.OP_CHECKMULTISIG);
    const sigs = node.parameters[0] as ArrayNode;
    const pks = node.parameters[1] as ArrayNode;
    this.popFromStack(sigs.elements.length + pks.elements.length + 2);
    this.pushToStack('(value)');

    return node;
  }

  needsToVerifyCovenant(node: FunctionCallNode): boolean {
    if (node.identifier.name !== GlobalFunction.CHECKSIG) return false;
    if (!this.isCheckSigVerify) return false;
    if (!this.covenantNeedsToBeVerified) return false;
    if (this.scopeDepth > 0) return false;
    return true;
  }

  verifyCovenant(): void {
    // Duplicate [s, pk] that are on stack
    this.emit(Op.OP_2DUP);
    this.pushToStack('(value)');
    this.pushToStack('(value)');

    // Turn sig into datasig
    this.emit([Op.OP_SWAP, Op.OP_SIZE, Op.OP_1SUB, Op.OP_SPLIT, Op.OP_DROP]);

    // Retrieve preimage from stack and hash it
    const preimageIndex = this.getStackIndex('$preimage');
    this.removeFromStack(preimageIndex);
    this.emit(encodeInt(preimageIndex));
    this.emit(Op.OP_ROLL);
    this.emit(Op.OP_SHA256);
    this.pushToStack('(value)');

    // Order arguments and perform OP_CHECKDATASIGVERIFY
    this.emit(Op.OP_ROT);
    this.emit(Op.OP_CHECKDATASIGVERIFY);
    this.popFromStack(3);

    this.covenantNeedsToBeVerified = false;
  }

  visitInstantiation(node: InstantiationNode): Node {
    if (node.identifier.name === Class.OUTPUT_P2PKH) {
      // <output amount>
      this.visit(node.parameters[0]);
      // <VarInt 25 bytes> OP_DUP OP_HASH160 OP_PUSH<20>
      this.emit(hexToBin('1976a914'));
      this.emit(Op.OP_CAT);
      // <pkh>
      this.visit(node.parameters[1]);
      this.emit(Op.OP_CAT);
      // OP_EQUAL OP_CHECKSIG
      this.emit(hexToBin('88ac'));
      this.emit(Op.OP_CAT);
      this.popFromStack(2);
    } else if (node.identifier.name === Class.OUTPUT_P2SH) {
      // <output amount>
      this.visit(node.parameters[0]);
      // <VarInt 23 bytes> OP_HASH160 OP_PUSH<20>
      this.emit(hexToBin('17a914'));
      this.emit(Op.OP_CAT);
      // <script hash>
      this.visit(node.parameters[1]);
      this.emit(Op.OP_CAT);
      // OP_EQUAL
      this.emit(hexToBin('87'));
      this.emit(Op.OP_CAT);
      this.popFromStack(2);
    } else if (node.identifier.name === Class.OUTPUT_NULLDATA) {
      // Total script = bytes8(0) <VarInt> OP_RETURN (<VarInt> <chunk>)+
      // <output amount (0)>
      this.emit(hexToBin('0000000000000000'));
      this.pushToStack('(value)');
      // OP_RETURN
      this.emit(hexToBin('6a'));
      this.pushToStack('(value)');
      const { elements } = node.parameters[0] as ArrayNode;
      // <VarInt data chunk size (dynamic)>
      elements.forEach((el) => {
        this.visit(el);
        // Push the element's size (and calculate VarInt)
        this.emit(Op.OP_SIZE);
        if (el instanceof HexLiteralNode) {
          // If the argument is a literal, we know its size
          if (el.value.byteLength > 75) {
            this.emit(hexToBin('4c'));
            this.emit(Op.OP_SWAP);
            this.emit(Op.OP_CAT);
          }
        } else {
          // If the argument is not a literal, the script needs to check size
          this.emit(Op.OP_DUP);
          this.emit(encodeInt(75));
          this.emit(Op.OP_GREATERTHAN);
          this.emit(Op.OP_IF);
          this.emit(hexToBin('4c'));
          this.emit(Op.OP_SWAP);
          this.emit(Op.OP_CAT);
          this.emit(Op.OP_ENDIF);
        }
        // Concat size and arguments
        this.emit(Op.OP_SWAP);
        this.emit(Op.OP_CAT);
        this.emit(Op.OP_CAT);
        this.popFromStack();
      });
      // <VarInt total script size>
      this.emit(Op.OP_SIZE);
      this.emit(Op.OP_SWAP);
      this.emit(Op.OP_CAT);
      this.emit(Op.OP_CAT);
      this.popFromStack(2);
    } else {
      throw new Error(); // Should not happen
    }
    this.pushToStack('(value)');

    return node;
  }

  visitTupleIndexOp(node: TupleIndexOpNode): Node {
    node.tuple = this.visit(node.tuple);

    if (node.index === 0) {
      this.emit(Op.OP_DROP);
      this.popFromStack();
    } else if (node.index === 1) {
      this.emit(Op.OP_NIP);
      this.nipFromStack();
    }

    return node;
  }

  visitBinaryOp(node: BinaryOpNode): Node {
    node.left = this.visit(node.left);
    node.right = this.visit(node.right);
    const isNumeric = resultingType(node.left.type, node.right.type) === PrimitiveType.INT;
    this.emit(compileBinaryOp(node.operator, isNumeric));
    this.popFromStack(2);
    this.pushToStack('(value)');
    if (node.operator === BinaryOperator.SPLIT) this.pushToStack('(value');
    return node;
  }

  visitUnaryOp(node: UnaryOpNode): Node {
    node.expression = this.visit(node.expression);
    this.emit(compileUnaryOp(node.operator));
    this.popFromStack();
    this.pushToStack('(value)');
    return node;
  }

  visitArray(node: ArrayNode): Node {
    node.elements = this.visitList(node.elements);
    this.emit(encodeInt(node.elements.length));
    this.pushToStack('(value)');
    return node;
  }

  visitIdentifier(node: IdentifierNode): Node {
    const stackIndex = this.getStackIndex(node.name);
    this.emit(encodeInt(stackIndex));

    // If the final use is inside an if-statement, we still OP_PICK it
    // We do this so that there's no difference in stack depths between execution paths
    if (this.isOpRoll(node)) {
      this.emit(Op.OP_ROLL);
      this.removeFromStack(stackIndex);
    } else {
      this.emit(Op.OP_PICK);
    }

    this.pushToStack('(value)');
    return node;
  }

  isOpRoll(node: IdentifierNode): boolean {
    return this.currentFunction.opRolls.get(node.name) === node && this.scopeDepth === 0;
  }

  visitBoolLiteral(node: BoolLiteralNode): Node {
    this.emit(encodeBool(node.value));
    this.pushToStack('(value)');
    return node;
  }

  visitIntLiteral(node: IntLiteralNode): Node {
    this.emit(encodeInt(node.value));
    this.pushToStack('(value)');
    return node;
  }

  visitStringLiteral(node: StringLiteralNode): Node {
    this.emit(encodeString(node.value));
    this.pushToStack('(value)');
    return node;
  }

  visitHexLiteral(node: HexLiteralNode): Node {
    this.emit(node.value);
    this.pushToStack('(value)');
    return node;
  }
}
