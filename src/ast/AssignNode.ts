import { Node } from "./Node";
import { IdentifierNode } from "./IdentifierNode";

export class AssignNode extends Node {
    constructor(
        public identifier: IdentifierNode,
        public expression: Node
    ) {
        super();
    }
}