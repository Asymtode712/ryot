import { APP_ROUTES } from "@/lib/constants";
import { useUserPreferences } from "@/lib/hooks";
import LoadingPage from "@/lib/layouts/LoadingPage";
import LoggedIn from "@/lib/layouts/LoggedIn";
import { gqlClient } from "@/lib/services/api";
import {
	Box,
	Button,
	Checkbox,
	Container,
	Flex,
	Input,
	NumberInput,
	Rating,
	SegmentedControl,
	Stack,
	Textarea,
	Title,
} from "@mantine/core";
import { useForm, zodResolver } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import {
	CollectionContentsDocument,
	DeleteReviewDocument,
	type DeleteReviewMutationVariables,
	MediaMainDetailsDocument,
	MetadataGroupDetailsDocument,
	MetadataLot,
	PersonDetailsDocument,
	PostReviewDocument,
	type PostReviewMutationVariables,
	ReviewDocument,
	UserReviewScale,
	Visibility,
} from "@ryot/generated/graphql/backend/graphql";
import { IconPercentage } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Head from "next/head";
import { useRouter } from "next/router";
import { type ReactElement, useEffect } from "react";
import invariant from "tiny-invariant";
import { match } from "ts-pattern";
import { withQuery } from "ufo";
import { z } from "zod";
import type { NextPageWithLayout } from "../_app";

const numberOrUndefined = z.any().optional();

const formSchema = z.object({
	rating: z.preprocess(Number, z.number().min(0).max(100)).optional(),
	text: z.string().optional(),
	visibility: z.nativeEnum(Visibility).default(Visibility.Public).optional(),
	spoiler: z.boolean().optional(),
	showSeasonNumber: numberOrUndefined,
	showEpisodeNumber: numberOrUndefined,
	podcastEpisodeNumber: numberOrUndefined,
});
type FormSchema = z.infer<typeof formSchema>;

const Page: NextPageWithLayout = () => {
	const router = useRouter();
	const metadataId = router.query.metadataId
		? parseInt(router.query.metadataId.toString())
		: undefined;
	const metadataGroupId = router.query.metadataGroupId
		? parseInt(router.query.metadataGroupId.toString())
		: undefined;
	const personId = router.query.personId
		? parseInt(router.query.personId.toString())
		: undefined;
	const collectionId = router.query.collectionId
		? parseInt(router.query.collectionId.toString())
		: undefined;
	const reviewId = Number(router.query.reviewId?.toString()) || null;
	const showSeasonNumber = Number(router.query.showSeasonNumber) || undefined;
	const showEpisodeNumber = Number(router.query.showEpisodeNumber) || undefined;
	const podcastEpisodeNumber =
		Number(router.query.podcastEpisodeNumber) || undefined;

	const form = useForm<FormSchema>({
		validate: zodResolver(formSchema),
		initialValues: {
			showSeasonNumber,
			showEpisodeNumber,
			podcastEpisodeNumber,
		},
	});

	const userPreferences = useUserPreferences();

	const mediaDetails = useQuery({
		queryKey: ["mediaDetails", metadataId, personId],
		queryFn: async () => {
			if (metadataId) {
				const { mediaDetails } = await gqlClient.request(
					MediaMainDetailsDocument,
					{ metadataId },
				);
				return {
					title: mediaDetails.title,
					isShow: mediaDetails.lot === MetadataLot.Show,
					isPodcast: mediaDetails.lot === MetadataLot.Podcast,
				};
			} else if (personId) {
				const { personDetails } = await gqlClient.request(
					PersonDetailsDocument,
					{ personId },
				);
				return {
					title: personDetails.details.name,
					isShow: false,
					isPodcast: false,
				};
			} else if (metadataGroupId) {
				const { metadataGroupDetails } = await gqlClient.request(
					MetadataGroupDetailsDocument,
					{ metadataGroupId },
				);
				return {
					title: metadataGroupDetails.details.title,
					isShow: false,
					isPodcast: false,
				};
			} else if (collectionId) {
				const { collectionContents } = await gqlClient.request(
					CollectionContentsDocument,
					{ input: { collectionId } },
				);
				return {
					title: collectionContents.details.name,
					isShow: false,
					isPodcast: false,
				};
			}
			return { title: "", isShow: false, isPodcast: false };
		},
		staleTime: Infinity,
	});

	const onSuccess = () => {
		let url;
		let id;
		if (router.query.next) url = router.query.next.toString();
		else if (metadataId) {
			url = APP_ROUTES.media.individualMediaItem.details;
			id = metadataId;
		} else if (personId) {
			url = APP_ROUTES.media.people.details;
			id = personId;
		} else if (metadataGroupId) {
			url = APP_ROUTES.media.groups.details;
			id = metadataGroupId;
		} else if (collectionId) {
			url = APP_ROUTES.collections.details;
			id = collectionId;
		}
		if (url) router.replace(withQuery(url, { id }));
	};

	const reviewDetails = useQuery({
		enabled: reviewId !== undefined,
		queryKey: ["reviewDetails", reviewId],
		queryFn: async () => {
			invariant(reviewId, "Can not get review details");
			const { review } = await gqlClient.request(ReviewDocument, {
				reviewId,
			});
			return review;
		},
		staleTime: Infinity,
	});

	useEffect(() => {
		if (reviewDetails.data) {
			form.setValues({
				rating: Number(reviewDetails.data.rating) ?? undefined,
				text: reviewDetails.data.text ?? undefined,
				visibility: reviewDetails.data.visibility,
				spoiler: reviewDetails.data.spoiler,
				podcastEpisodeNumber: reviewDetails.data.podcastEpisode ?? undefined,
				showSeasonNumber: reviewDetails.data.showSeason ?? undefined,
				showEpisodeNumber: reviewDetails.data.showEpisode ?? undefined,
			});
			form.resetDirty();
		}
	}, [reviewDetails.data]);

	const postReview = useMutation({
		mutationFn: async (variables: PostReviewMutationVariables) => {
			if (variables.input.podcastEpisodeNumber?.toString() === "")
				variables.input.podcastEpisodeNumber = undefined;
			if (variables.input.showSeasonNumber?.toString() === "")
				variables.input.showSeasonNumber = undefined;
			if (variables.input.showEpisodeNumber?.toString() === "")
				variables.input.showEpisodeNumber = undefined;
			const { postReview } = await gqlClient.request(
				PostReviewDocument,
				variables,
			);
			return postReview;
		},
		onSuccess,
		// biome-ignore lint/suspicious/noExplicitAny: required
		onError: (e: any) => {
			notifications.show({
				message: e.response.errors[0].message,
				color: "red",
			});
		},
	});

	const deleteReview = useMutation({
		mutationFn: async (variables: DeleteReviewMutationVariables) => {
			const { deleteReview } = await gqlClient.request(
				DeleteReviewDocument,
				variables,
			);
			return deleteReview;
		},
		onSuccess,
	});

	const title = mediaDetails.data?.title;

	return userPreferences.data && mediaDetails.data && title ? (
		<>
			<Head>
				<title>Post Review | Ryot</title>
			</Head>
			<Container size="xs">
				<Box
					component="form"
					onSubmit={form.onSubmit((values) => {
						postReview.mutate({
							input: {
								metadataId,
								personId,
								collectionId,
								metadataGroupId,
								...values,
								reviewId,
								rating: values.rating?.toString(),
							},
						});
					})}
				>
					<Stack>
						<Title order={3}>Reviewing "{title}"</Title>
						<Flex align="center" gap="xl">
							{match(userPreferences.data.general.reviewScale)
								.with(UserReviewScale.OutOfFive, () => (
									<Flex gap="sm" mt="lg">
										<Input.Label>Rating:</Input.Label>
										<Rating {...form.getInputProps("rating")} fractions={2} />
									</Flex>
								))
								.with(UserReviewScale.OutOfHundred, () => (
									<NumberInput
										label="Rating"
										{...form.getInputProps("rating")}
										min={0}
										max={100}
										step={1}
										w="40%"
										hideControls
										rightSection={<IconPercentage size={16} />}
									/>
								))
								.exhaustive()}
							<Checkbox
								label="This review is a spoiler"
								mt="lg"
								{...form.getInputProps("spoiler", { type: "checkbox" })}
							/>
						</Flex>
						{mediaDetails.data.isShow ? (
							<Flex gap="md">
								<NumberInput
									label="Season"
									{...form.getInputProps("showSeasonNumber")}
									hideControls
								/>
								<NumberInput
									label="Episode"
									{...form.getInputProps("showEpisodeNumber")}
									hideControls
								/>
							</Flex>
						) : undefined}
						{mediaDetails.data.isPodcast ? (
							<Flex gap="md">
								<NumberInput
									label="Episode"
									{...form.getInputProps("podcastEpisodeNumber")}
									hideControls
								/>
							</Flex>
						) : undefined}
						<Textarea
							label="Review"
							description="Markdown is supported"
							{...form.getInputProps("text")}
							autoFocus
							minRows={10}
							autosize
						/>
						<Box>
							<Input.Label>Visibility</Input.Label>
							<SegmentedControl
								fullWidth
								data={[
									{
										label: Visibility.Public,
										value: Visibility.Public,
									},
									{
										label: Visibility.Private,
										value: Visibility.Private,
									},
								]}
								{...form.getInputProps("visibility")}
							/>
						</Box>
						<Button
							mt="md"
							type="submit"
							loading={postReview.isPending}
							w="100%"
						>
							{reviewId ? "Update" : "Submit"}
						</Button>
						{reviewId ? (
							<Button
								loading={deleteReview.isPending}
								w="100%"
								color="red"
								onClick={() => {
									const yes = confirm(
										"Are you sure you want to delete this review?",
									);
									if (yes) deleteReview.mutate({ reviewId });
								}}
							>
								Delete
							</Button>
						) : undefined}
					</Stack>
				</Box>
			</Container>
		</>
	) : (
		<LoadingPage />
	);
};

Page.getLayout = (page: ReactElement) => {
	return <LoggedIn>{page}</LoggedIn>;
};

export default Page;
