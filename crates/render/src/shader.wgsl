struct Camera {
    view_proj: mat4x4<f32>,
};

@group(0) @binding(0)
var<uniform> camera: Camera;

@group(1) @binding(0)
var base_tex: texture_2d<f32>;
@group(1) @binding(1)
var base_sampler: sampler;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) color: vec4<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.clip_position = camera.view_proj * vec4<f32>(in.position, 1.0);
    out.normal = in.normal;
    out.uv = in.uv;
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let n = normalize(in.normal);
    let key = normalize(vec3<f32>(0.45, 0.92, 0.55));
    let fill = normalize(vec3<f32>(-0.4, 0.3, 0.55));
    let ambient = 0.22;
    let diffuse = max(dot(n, key), 0.0) * 0.7 + max(dot(n, fill), 0.0) * 0.3;
    let lit = ambient + diffuse;

    let tex = textureSample(base_tex, base_sampler, in.uv);
    let albedo = tex.rgb * in.color.rgb;

    // sRGB-ish display gamma
    let rgb = pow(albedo * lit, vec3<f32>(1.0 / 2.2));
    return vec4<f32>(rgb, in.color.a);
}
