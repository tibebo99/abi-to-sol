import type Prettier from "prettier";
import * as Codec from "@truffle/codec";
import type * as Abi from "@truffle/abi-utils";
import type {Abi as SchemaAbi} from "@truffle/contract-schema/spec";

import { version } from "../package.json";
import {Visitor, VisitOptions, dispatch, Node} from "./visitor";
import { forRange, VersionFeatures, mixed } from "./version-features";
import { GenerateSolidityOptions, GenerateSolidityMode } from "./options";
import * as defaults from "./defaults";
import {
  Component,
  Declaration,
  Declarations,
  collectDeclarations,
} from "./declarations";
import { collectAbiFeatures, AbiFeatures } from "./abi-features";

let prettier: typeof Prettier
try {
  prettier = require("prettier");
} catch {
  // no-op
}

export const generateSolidity = ({
  abi,
  name = defaults.name,
  solidityVersion = defaults.solidityVersion,
  license = defaults.license,
  mode = defaults.mode,
  outputAttribution = defaults.outputAttribution,
  outputSource = defaults.outputSource,
  prettifyOutput = prettier && defaults.prettifyOutput,
}: GenerateSolidityOptions) => {
  if (!prettier && prettifyOutput) {
    throw new Error("Could not require() prettier");
  }

  const versionFeatures = forRange(solidityVersion);
  const abiFeatures = collectAbiFeatures(abi);
  const declarations = collectDeclarations(abi);

  const generated = dispatch({
    node: abi,
    visitor: new SolidityGenerator({
      name,
      solidityVersion,
      license,
      mode,
      outputAttribution,
      outputSource,
      versionFeatures,
      abiFeatures,
      declarations,
    }),
  });

  if (!prettifyOutput) {
    return generated;
  }

  try {
    return prettier.format(generated, {
      plugins: ["prettier-plugin-solidity"],
      // @ts-ignore
      parser: "solidity-parse",
    });
  } catch (error) {
    return generated;
  }
};

interface Context {
  interfaceName?: string;
  parameterModifiers?: (parameter: Abi.Parameter) => string[];
}

type Visit<N extends Node> = VisitOptions<N, Context | undefined>;

type ConstructorOptions = {
  versionFeatures: VersionFeatures;
  abiFeatures: AbiFeatures;
  declarations: Declarations;
} & Required<
  Omit<GenerateSolidityOptions, "abi" | "prettifyOutput">
>;

const shimGlobalInterfaceName = "__Structs";

class SolidityGenerator implements Visitor<string, Context | undefined> {
  private name: string;
  private license: string;
  private mode: GenerateSolidityMode;
  private solidityVersion: string;
  private outputAttribution: boolean;
  private outputSource: boolean;
  private versionFeatures: VersionFeatures;
  private abiFeatures: AbiFeatures;
  private declarations: Declarations;
  private identifiers: {
    [signature: string]: {
      identifier: string;
      container?: string;
    }
  };

  constructor({
    name,
    license,
    mode,
    outputAttribution,
    outputSource,
    solidityVersion,
    versionFeatures,
    abiFeatures,
    declarations,
  }: ConstructorOptions) {
    this.name = name;
    this.license = license;
    this.mode = mode;
    this.solidityVersion = solidityVersion;
    this.versionFeatures = versionFeatures;
    this.abiFeatures = abiFeatures;
    this.declarations = declarations;
    this.outputAttribution = outputAttribution;
    this.outputSource = outputSource;

    this.identifiers = {};
    let index = 0;
    for (const [container, signatures] of Object.entries(declarations.containerSignatures)) {
      for (const signature of signatures) {
        const {
          identifier = `S_${index++}`
        } = declarations.signatureDeclarations[signature];

        if (container === "" && this.versionFeatures["global-structs"] !== true) {
          this.identifiers[signature] = {
            container: shimGlobalInterfaceName,
            identifier
          };
        } else if (container === "") {
          this.identifiers[signature] = { identifier };
        } else {
          this.identifiers[signature] = {
            container,
            identifier
          }
        }
      }
    }
  }

  visitAbi({node: abi}: Visit<Abi.Abi>) {
    switch (this.mode) {
      case GenerateSolidityMode.Normal: {
        return [
          this.generateHeader(),
          this.generateInterface(abi),
          this.generateDeclarations(),
          this.generateAutogeneratedNotice(abi),
        ].join("\n\n");
      }
      case GenerateSolidityMode.Embedded: {
        return [
          this.generateInterface(abi),
          this.generateDeclarations(),
        ].join("\n\n");
      }
    }
  }

  visitFunctionEntry({node: entry, context}: Visit<Abi.FunctionEntry>): string {
    const {name, inputs, stateMutability} = entry;

    return [
      `function ${name}(`,
      entry.inputs.map((node) =>
        dispatch({
          node,
          visitor: this,
          context: {
            ...context,
            parameterModifiers: (parameter: Abi.Parameter) =>
              parameter.type.startsWith("tuple") ||
              parameter.type.includes("[") ||
              parameter.type === "bytes" ||
              parameter.type === "string"
                ? [this.generateArrayParameterLocation(parameter)]
                : [],
          },
        })
      ),
      `) external`,
      this.generateStateMutability(entry),
      entry.outputs && entry.outputs.length > 0
        ? [
            `returns (`,
            entry.outputs
              .map((node) =>
                dispatch({
                  node,
                  visitor: this,
                  context: {
                    parameterModifiers: (parameter: Abi.Parameter) =>
                      parameter.type.startsWith("tuple") ||
                      parameter.type.includes("[") ||
                      parameter.type === "bytes" ||
                      parameter.type === "string"
                        ? ["memory"]
                        : [],
                  },
                })
              )
              .join(", "),
            `)`,
          ].join("")
        : ``,
      `;`,
    ].join(" ");
  }

  visitConstructorEntry({node: entry}: Visit<Abi.ConstructorEntry>): string {
    // interfaces don't have constructors
    return "";
  }

  visitFallbackEntry({ node: entry }: Visit<Abi.FallbackEntry>): string {
    const servesAsReceive = this.abiFeatures["defines-receive"] &&
       this.versionFeatures["receive-keyword"] !== true;

    const { stateMutability } = entry;
    return `${this.generateFallbackName()} () external ${
      stateMutability === "payable" || servesAsReceive ? "payable" : ""
     };`;
  }

  visitReceiveEntry() {
    // if version has receive, emit as normal
    if (this.versionFeatures["receive-keyword"] === true) {
      return `receive () external payable;`;
    }

    // if this ABI defines a fallback separately, emit nothing, since
    // visitFallbackEntry will cover it
    if (this.abiFeatures["defines-fallback"]) {
      return "";
    }

    // otherwise, explicitly invoke visitFallbackEntry
    return this.visitFallbackEntry({
      node: { type: "fallback", stateMutability: "payable" },
    });
  }

  visitEventEntry({node: entry, context}: Visit<Abi.EventEntry>): string {
    const {name, inputs, anonymous} = entry;

    return [
      `event ${name}(`,
      inputs.map((node) =>
        dispatch({
          node,
          visitor: this,
          context: {
            ...context,
            parameterModifiers: (parameter: Abi.Parameter) =>
              // TODO fix this
              (parameter as Abi.EventParameter).indexed ? ["indexed"] : [],
          },
        })
      ),
      `)`,
      `${anonymous ? "anonymous" : ""};`,
    ].join(" ");
  }

  visitErrorEntry({node: entry, context}: Visit<Abi.ErrorEntry>): string {
    if (this.versionFeatures["custom-errors"] !== true) {
      throw new Error("ABI defines custom errors; use Solidity v0.8.4 or higher");
    }

    const {name, inputs} = entry;

    return [
      `error ${name}(`,
      inputs.map((node) =>
        dispatch({
          node,
          visitor: this,
          context: {
            ...context,
            parameterModifiers: (parameter: Abi.Parameter) => []
          },
        })
      ),
      `);`,
    ].join(" ");
  }

  visitParameter({node: parameter, context}: Visit<Abi.Parameter>) {
    const type = this.generateType(parameter, context);

    // @ts-ignore
    const {parameterModifiers} = context;

    return [type, ...parameterModifiers(parameter), parameter.name].join(" ");
  }

  private generateHeader(): string {
    const includeExperimentalPragma =
      this.abiFeatures["needs-abiencoder-v2"] &&
      this.versionFeatures["abiencoder-v2"] !== "default";

    const attribution =
      !this.outputAttribution
        ? []
        : [this.generateAttribution()]

    return [
      `// SPDX-License-Identifier: ${this.license}`,
      ...attribution,
      `pragma solidity ${this.solidityVersion};`,
      ...(
        includeExperimentalPragma
          ? [`pragma experimental ABIEncoderV2;`]
          : []
      )
    ].join("\n");
  }

  private generateAttribution(): string {
    const unit = this.mode === GenerateSolidityMode.Normal
      ? "FILE"
      : "INTERFACE"
    return this.outputSource
      ? `// !! THIS ${unit} WAS AUTOGENERATED BY abi-to-sol v${version}. SEE SOURCE BELOW. !!`
      : `// !! THIS ${unit} WAS AUTOGENERATED BY abi-to-sol v${version}. !!`;
  }

  private generateAutogeneratedNotice(abi: Abi.Abi): string {
    if (!this.outputSource) {
      return "";
    }

    return [
      ``,
      `// THIS FILE WAS AUTOGENERATED FROM THE FOLLOWING ABI JSON:`,
      `/*`,
      JSON.stringify(abi),
      `*/`,
    ].join("\n");
  }

  private generateDeclarations(): string {
    if (
      this.versionFeatures["structs-in-interfaces"] !== true &&
      Object.keys(this.declarations.signatureDeclarations).length > 0
    ) {
      throw new Error(
        "abi-to-sol does not support custom struct types for this Solidity version"
      );
    }

    const externalContainers = Object.keys(this.declarations.containerSignatures)
      .filter(container => container !== "" && container !== this.name);

    const externalDeclarations = externalContainers
      .map(container => [
        `interface ${container} {`,
          this.generateDeclarationsForContainer(container),
        `}`
      ].join("\n"))
      .join("\n\n");

    const globalSignatures = this.declarations.containerSignatures[""] || [];
    if (globalSignatures.length > 0) {
      const declarations = this.versionFeatures["global-structs"] === true
        ? this.generateDeclarationsForContainer("")
        : [
            `interface ${shimGlobalInterfaceName} {`,
            this.generateDeclarationsForContainer(""),
            `}`
          ].join("\n");

      return [declarations, externalDeclarations].join("\n\n");
    }

    return externalDeclarations;
  }

  private generateDeclarationsForContainer(container: string): string {
    const signatures = new Set(
      this.declarations.containerSignatures[container]
    );

    if (container === "" && this.versionFeatures["global-structs"] !== true) {
      container = shimGlobalInterfaceName;
    }

    return Object.entries(this.declarations.signatureDeclarations)
      .filter(([signature]) => signatures.has(signature))
      .map(([signature, declaration]) => {
        const { identifier } = this.identifiers[signature];
        const components = this.generateComponents(declaration, { interfaceName: container });

        return `struct ${identifier} { ${components} }`;
      })
      .join("\n\n");
  }

  private generateComponents(
    declaration: Declaration,
    context?: Pick<Context, "interfaceName">
  ): string {
    return declaration.components
      .map((component) => {
        const {name} = component;

        return `${this.generateType(component, context)} ${name};`;
      })
      .join("\n");
  }

  private generateType(
    variable: Abi.Parameter | Component,
    context: Pick<Context, "interfaceName"> = {}
  ): string {
    const signature = this.generateSignature(variable);

    if (!signature) {
      return this.generateElementaryType(variable, context);
    }

    const { type } = variable;

    const { container, identifier } = this.identifiers[signature];

    if (container && container !== context.interfaceName) {
      return type.replace("tuple", `${container}.${identifier}`);
    }

    if (!container && this.versionFeatures["global-structs"] !== true) {
      return type.replace("tuple", `${shimGlobalInterfaceName}.${identifier}`);
    }

    return type.replace("tuple", identifier);
  }

  private generateElementaryType(
    variable: Abi.Parameter | Component,
    context: Pick<Context, "interfaceName"> = {}
  ): string {
    // normally we can return the type itself, but functions are a special case
    if (variable.type !== "function") {
      return variable.type;
    }

    // use just the `internalType` field if it exists
    if ("internalType" in variable && variable.internalType) {
      return variable.internalType;
    }

    // otherwise output minimally syntactically-valid syntax with a warning
    return [
      "/* warning: the following type may be incomplete. ",
      "the receiving contract may expect additional input or output parameters. */ ",
      "function() external"
    ].join("");
  }


  private generateSignature(
    variable: Abi.Parameter | Component
  ): string | undefined {
    if ("signature" in variable && variable.signature) {
      return variable.signature;
    }

    if ("components" in variable && variable.components) {
      return Codec.AbiData.Utils.abiTupleSignature(variable.components);
    }
  }

  private generateStateMutability(
    entry:
      | Abi.FunctionEntry
      | Abi.FallbackEntry
      | Abi.ConstructorEntry
      | Abi.ReceiveEntry
  ): string {
    if (entry.stateMutability && entry.stateMutability !== "nonpayable") {
      return entry.stateMutability;
    }

    return "";
  }

  private generateFallbackName(): string {
    switch (this.versionFeatures["fallback-keyword"]) {
      case true: {
        return "fallback";
      }
      case false: {
        return "function";
      }
      case mixed: {
        throw new Error(
          `Desired Solidity range lacks unambigious fallback syntax.`
        );
      }
    }
  }

  private generateArrayParameterLocation(parameter: Abi.Parameter): string {
    switch (this.versionFeatures["array-parameter-location"]) {
      case undefined: {
        return "";
      }
      case mixed: {
        throw new Error(
          `Desired Solidity range lacks unambiguous location specifier for ` +
          `parameter of type "${parameter.type}".`
        );
      }
      default: {
        return this.versionFeatures["array-parameter-location"];
      }
    }
  }

  private generateInterface(abi: Abi.Abi): string {
    return [
      `interface ${this.name} {`,
        ...(
          this.mode === GenerateSolidityMode.Embedded && this.outputAttribution
            ? [this.generateAttribution()]
            : []
        ),
        this.generateDeclarationsForContainer(this.name),
        ``,
        ...abi.map((node) => dispatch({
          node,
          context: { interfaceName: this.name },
          visitor: this
        })),
        ...(
          this.mode === GenerateSolidityMode.Embedded
            ? [this.generateAutogeneratedNotice(abi)]
            : []
        ),
      `}`,
    ].join("\n");
  }
}
